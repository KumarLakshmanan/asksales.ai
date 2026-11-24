import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const signingKey = randomBytes(32);
const lifetime = 2 * 60 * 60 * 1000;
export interface AssistantPreviewIdentity {
  userId: number;
  businessProfileId: number;
  assistantId: string;
  configurationVersion: string;
  channel: string;
}
/** Isolated preview state is never a customer conversation. A continuation is
 * signed for this exact owner/profile/assistant/configuration/channel. */
export function assistantPreviewSession(
  identity: AssistantPreviewIdentity,
  input: { conversationId?: unknown; previewSessionToken?: unknown },
  now = Date.now(),
) {
  const sign = (id: number, issued: number) =>
    createHmac("sha256", signingKey)
      .update(
        JSON.stringify([
          identity.userId,
          identity.businessProfileId,
          identity.assistantId,
          identity.configurationVersion,
          identity.channel,
          id,
          issued,
        ]),
      )
      .digest("hex");
  if (
    input.conversationId !== undefined ||
    input.previewSessionToken !== undefined
  ) {
    const id = input.conversationId;
    const token =
      typeof input.previewSessionToken === "string"
        ? input.previewSessionToken
        : "";
    const [stamp, signature] = token.split(".");
    const issued = Number(stamp);
    if (
      !Number.isSafeInteger(id) ||
      typeof id !== "number" ||
      id > -1500000000 ||
      id <= -2000000000 ||
      !Number.isSafeInteger(issued) ||
      issued > now ||
      now - issued > lifetime ||
      !/^[0-9a-f]{64}$/.test(signature || "") ||
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(sign(id, issued), "hex"),
      )
    ) {
      throw new Error(
        "This simulator session expired or belongs to a different assistant configuration. Start a new test.",
      );
    }
    return { conversationId: id, previewSessionToken: token };
  }
  const conversationId = -(1500000000 + randomInt(0, 500000000));
  return {
    conversationId,
    previewSessionToken: `${now}.${sign(conversationId, now)}`,
  };
}
