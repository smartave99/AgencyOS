import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateInvoiceDto {
  @IsString()
  customerId: string;

  @IsNumber()
  @Min(0.01, { message: 'Invoice amount must be greater than zero' })
  amount: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  items?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
