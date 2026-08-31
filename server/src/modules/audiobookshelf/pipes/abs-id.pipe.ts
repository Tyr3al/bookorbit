import { BadRequestException } from '@nestjs/common';

import { fromAbsUuid } from '../../../common/utils/abs-id.utils';

/**
 * ABS clients (Prologue) echo back the UUID-shaped ids BookOrbit hands out in list/login
 * responses, so `:id` route params on the Audiobookshelf-compatible API arrive as those UUIDs,
 * not plain integers. Reverses `toAbsUuid()` back to the real numeric primary key.
 *
 * A plain function rather than a NestJS PipeTransform: Nest/Fastify apply implicit numeric
 * coercion to `@Param()` values reflected as `number` before a param-level pipe ever sees them,
 * which mangles a UUID string into NaN. Taking the param as a raw string and converting inline
 * sidesteps that entirely.
 */
export function parseAbsId(value: string): number {
  const fromUuid = fromAbsUuid(value);
  if (fromUuid !== null) return fromUuid;

  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt) && String(asInt) === value) return asInt;

  throw new BadRequestException(`Invalid id: ${value}`);
}
