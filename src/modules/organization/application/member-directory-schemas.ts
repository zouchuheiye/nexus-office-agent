import { z } from "zod";

export const createMemberSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(200).optional(),
  orgUnitId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  isManager: z.boolean().optional(),
}).strict();

export const updateMemberSchema = z.object({
  expectedVersion: z.number().int().positive(),
  displayName: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().email().max(200).optional(),
  orgUnitId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  isManager: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const provided = ["displayName", "email", "orgUnitId", "positionId", "isManager"].some((key) => value[key as keyof typeof value] !== undefined);
  if (!provided) context.addIssue({ code: "custom", path: [], message: "至少需要修改一个字段。" });
});

export const deactivateMemberSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type DeactivateMemberInput = z.infer<typeof deactivateMemberSchema>;
