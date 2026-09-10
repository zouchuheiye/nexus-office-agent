import { z } from "zod";

/** 姓名是唯一必填项：入职当天部门/岗位/邮箱常常未定，留空合法（后续用 update 补全）。 */
export const displayName = z.string().trim().min(1).max(80);
export const memberEmail = z.string().trim().email().max(200);

export const createMemberSchema = z.object({
  displayName,
  email: memberEmail.optional(),
  orgUnitId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  isManager: z.boolean().optional(),
}).strict();

export const updateMemberSchema = z.object({
  expectedVersion: z.number().int().positive(),
  displayName: displayName.optional(),
  email: memberEmail.optional(),
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
