export type PostbackKind = "reveal" | "followcheck";
const ID = /^[A-Za-z0-9_-]+$/;

export function encodePostback(kind: PostbackKind, automationId: string, originId: string): string {
  if (!ID.test(automationId) || !originId || !ID.test(originId)) throw new Error("Invalid postback origin");
  return `${kind}:v1:${automationId}:${originId}`;
}

export function parsePostback(payload: string): { kind: PostbackKind; automationId: string; originId?: string } | null {
  const parts = payload.split(":");
  if (parts[0] !== "reveal" && parts[0] !== "followcheck") return null;
  if (parts.length === 2 && ID.test(parts[1])) return { kind: parts[0], automationId: parts[1] };
  if (parts.length === 4 && parts[1] === "v1" && ID.test(parts[2]) && ID.test(parts[3])) return { kind: parts[0], automationId: parts[2], originId: parts[3] };
  return null;
}
