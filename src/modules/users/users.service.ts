import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PasswordHasher } from '../../auth/password-hasher.service';
import type { AuthContext } from '../../auth/auth.types';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../common/db/pg-errors';
import { uuidv7 } from '../../common/ids/uuidv7';
import { normalizePhone } from '../../common/phone';
import type { Role } from '../../database/database.types';
import { TenantDatabase } from '../../database/tenant-database.service';
import { EventPublisher } from '../../events/event-publisher.service';
import { EventTypes } from '../../events/event-types';
import type { CreateUserDto, UserDto } from './dto/users.dto';

/** Which roles each role may create and manage. Owners are created only at signup for now. */
const MANAGEABLE_ROLES: Record<Role, readonly Role[]> = {
  owner: ['manager', 'cashier', 'driver'],
  manager: ['cashier', 'driver'],
  cashier: [],
  driver: [],
};

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly passwords: PasswordHasher,
    private readonly events: EventPublisher,
  ) {}

  async list(): Promise<UserDto[]> {
    const rows = await this.tenantDb.transaction((trx) =>
      trx
        .selectFrom('users')
        .select([
          'id',
          'full_name',
          'email',
          'phone',
          'role',
          'default_location_id',
          'is_active',
          'password_hash',
          'pin_hash',
          'created_at',
        ])
        .orderBy('created_at')
        .execute(),
    );
    return rows.map(toUserDto);
  }

  async create(actor: AuthContext, dto: CreateUserDto): Promise<UserDto> {
    assertCanManage(actor.role, dto.role);

    const email = dto.email?.trim().toLowerCase() ?? null;
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.password && !email && !phone) {
      throw new BadRequestException('A user with a password needs an email or phone number to sign in with');
    }

    const [passwordHash, pinHash] = await Promise.all([
      dto.password ? this.passwords.hash(dto.password) : Promise.resolve(null),
      dto.pin ? this.passwords.hash(dto.pin) : Promise.resolve(null),
    ]);
    const id = uuidv7();

    try {
      const row = await this.tenantDb.transaction(async (trx) => {
        const created = await trx
          .insertInto('users')
          .values({
            id,
            organization_id: actor.organizationId,
            full_name: dto.fullName.trim(),
            email,
            phone,
            role: dto.role,
            password_hash: passwordHash,
            pin_hash: pinHash,
            default_location_id: dto.defaultLocationId ?? null,
          })
          .returning([
            'id',
            'full_name',
            'email',
            'phone',
            'role',
            'default_location_id',
            'is_active',
            'password_hash',
            'pin_hash',
            'created_at',
          ])
          .executeTakeFirstOrThrow();

        const view = toUserDto(created);
        await this.events.record(trx, {
          type: EventTypes.UserCreated,
          aggregateType: 'user',
          aggregateId: id,
          payload: {
            after: {
              fullName: view.fullName,
              role: view.role,
              email: view.email,
              phone: view.phone,
              defaultLocationId: view.defaultLocationId,
              hasPassword: view.hasPassword,
              hasPin: view.hasPin,
            },
          },
        });
        return view;
      });
      return row;
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === PG_UNIQUE_VIOLATION) throw new ConflictException('That email or phone number is already used to sign in');
      if (code === PG_FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown location');
      throw err;
    }
  }

  /** Staff set their own PIN; owners/managers can set or reset it for staff they manage. */
  async setPin(actor: AuthContext, userId: string, pin: string): Promise<void> {
    const pinHash = await this.passwords.hash(pin);

    await this.tenantDb.transaction(async (trx) => {
      const target = await trx
        .selectFrom('users')
        .select(['id', 'role'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new NotFoundException('User not found');
      if (target.id !== actor.userId) assertCanManage(actor.role, target.role);

      await trx
        .updateTable('users')
        .set({ pin_hash: pinHash, pin_failed_attempts: 0, pin_locked_until: null })
        .where('id', '=', userId)
        .execute();

      await this.events.record(trx, {
        type: EventTypes.UserPinChanged,
        aggregateType: 'user',
        aggregateId: userId,
        payload: { selfService: target.id === actor.userId },
      });
    });
  }
}

function assertCanManage(actorRole: Role, targetRole: Role): void {
  if (!MANAGEABLE_ROLES[actorRole].includes(targetRole)) {
    throw new ForbiddenException(`A ${actorRole} cannot manage ${targetRole} accounts`);
  }
}

function toUserDto(row: {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  default_location_id: string | null;
  is_active: boolean;
  password_hash: string | null;
  pin_hash: string | null;
  created_at: Date;
}): UserDto {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    defaultLocationId: row.default_location_id,
    isActive: row.is_active,
    hasPassword: row.password_hash !== null,
    hasPin: row.pin_hash !== null,
    createdAt: row.created_at,
  };
}
