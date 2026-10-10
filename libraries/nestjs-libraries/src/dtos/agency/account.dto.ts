import { IsString, IsNotEmpty } from 'class-validator';

export class AssignClientDto {
  @IsString()
  @IsNotEmpty()
  customerId: string;
}

export class TestConnectionDto {
  @IsString()
  @IsNotEmpty()
  integrationId: string;
}
