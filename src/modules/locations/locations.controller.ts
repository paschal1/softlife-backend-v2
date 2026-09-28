import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CreateLocationDto, LocationDto } from './dto/locations.dto';
import { LocationsService } from './locations.service';

@ApiTags('Locations (branches)')
@ApiBearerAuth()
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @ApiOperation({ summary: 'List branches' })
  @ApiOkResponse({ type: [LocationDto] })
  list(): Promise<LocationDto[]> {
    return this.locations.list();
  }

  @Post()
  @Roles('owner')
  @ApiOperation({ summary: 'Add a branch' })
  @ApiCreatedResponse({ type: LocationDto })
  create(@Body() dto: CreateLocationDto): Promise<LocationDto> {
    return this.locations.create(dto);
  }
}
