import { headers } from "next/headers";
import { authDisabled, authorize } from "./access";
export async function requireAccess() {
  if (authDisabled()) return;
  if (!authorize((await headers()).get("authorization"))) throw new Error("Authentication required");
}
