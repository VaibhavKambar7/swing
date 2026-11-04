import { headers } from "next/headers";
import { authorize } from "./access";
export async function requireAccess() {
  if (!authorize((await headers()).get("authorization"))) throw new Error("Authentication required");
}
