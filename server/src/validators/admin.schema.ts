import { z } from 'zod';

/** Admin-only reset of stations and medicines. The typed word guards against accidental clicks. */
export const resetStationsMedicinesSchema = z.object({
  confirmation: z.literal('DELETE', { message: 'Type DELETE to confirm' }),
});
