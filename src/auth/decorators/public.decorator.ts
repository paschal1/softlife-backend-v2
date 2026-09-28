import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Routes are authenticated by default. Mark the exceptions explicitly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
