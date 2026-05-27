export const preprocessJson = (val: unknown): unknown =>
  typeof val === "string" ? JSON.parse(val) : val;
