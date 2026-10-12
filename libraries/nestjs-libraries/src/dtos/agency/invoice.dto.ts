import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export class CreateInvoiceDto {
  @IsString()
  customerId: string;

  @IsNumber()
  @Min(0.01, { message: 'Invoice amount must be greater than zero' })
  amount: number;

  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/, { message: 'Currency must be a 3-letter code' })
  currency?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Due date must be a valid date' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  items?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
