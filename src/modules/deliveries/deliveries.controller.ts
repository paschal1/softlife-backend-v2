import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { AuthContext } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DeliveriesService } from './deliveries.service';
import {
  AssignDeliveryDto,
  ConfirmDeliveryDto,
  DeliveryDto,
  DeliveryPageDto,
  DriverCashDto,
  FailDeliveryDto,
  ListDeliveriesQueryDto,
  RemitCashDto,
  RemittanceDto,
  SignatureLinkDto,
} from './dto/deliveries.dto';

@ApiTags('Deliveries')
@ApiBearerAuth()
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @ApiOperation({
    summary: 'Delivery queue (DEL-01)',
    description: 'Open deliveries and pickups by default, earliest scheduled date first. Drivers see only their own and never the confirmation code.',
  })
  @ApiOkResponse({ type: DeliveryPageDto })
  list(@CurrentUser() auth: AuthContext, @Query() query: ListDeliveriesQueryDto): Promise<DeliveryPageDto> {
    return this.deliveries.list(auth, query);
  }

  @Get('driver-cash')
  @ApiOperation({ summary: 'Cash still with drivers', description: 'Collected at doors, not yet handed in at a till. Drivers see only their own.' })
  @ApiOkResponse({ type: [DriverCashDto] })
  driverCash(@CurrentUser() auth: AuthContext): Promise<DriverCashDto[]> {
    return this.deliveries.driverCash(auth);
  }

  @Post('remittances')
  @ApiOperation({
    summary: 'Driver hands in collected cash',
    description: "Receiver must be clocked in; the cash joins their till's EOD. Enter what was counted: a short or over amount is recorded and flagged above the business's variance threshold.",
  })
  @ApiCreatedResponse({ type: RemittanceDto })
  remit(@CurrentUser() auth: AuthContext, @Body() dto: RemitCashDto): Promise<RemittanceDto> {
    return this.deliveries.remit(auth, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One delivery with items, collections and returns' })
  @ApiOkResponse({ type: DeliveryDto })
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DeliveryDto> {
    return this.deliveries.get(auth, id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Assign a driver and expected time (DEL-02)', description: 'Also used to reassign after a failed attempt.' })
  @ApiOkResponse({ type: DeliveryDto })
  assign(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDeliveryDto): Promise<DeliveryDto> {
    return this.deliveries.assign(auth, id, dto);
  }

  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark out for delivery', description: 'The assigned driver (or a manager) as the goods leave.' })
  @ApiOkResponse({ type: DeliveryDto })
  dispatch(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DeliveryDto> {
    return this.deliveries.dispatch(auth, id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm delivery or pickup (DEL-03)',
    description:
      "Proof is the 4-digit code from the customer's receipt (5 wrong tries locks it; a manager then confirms with the recipient's name). " +
      'Any amount due must be collected in full. Returned empties or refused goods go back into stock.',
  })
  @ApiOkResponse({ type: DeliveryDto })
  @ApiUnauthorizedResponse({ description: 'Wrong delivery code' })
  confirm(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmDeliveryDto): Promise<DeliveryDto> {
    return this.deliveries.confirm(auth, id, dto);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a failed attempt', description: 'Reason required. A manager can then reassign it.' })
  @ApiOkResponse({ type: DeliveryDto })
  fail(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FailDeliveryDto): Promise<DeliveryDto> {
    return this.deliveries.fail(auth, id, dto);
  }

  @Get(':id/signature')
  @ApiOperation({ summary: 'Link to the signature captured at delivery', description: 'Owners/managers or the assigned driver. Valid for 15 minutes.' })
  @ApiOkResponse({ type: SignatureLinkDto })
  signature(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SignatureLinkDto> {
    return this.deliveries.signatureLink(auth, id);
  }
}
