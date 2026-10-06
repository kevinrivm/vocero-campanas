import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { normalizeMx } from "@/lib/meta/client";
import { getOrCreateConversation } from "@/server/inbox/ingest";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import { SendError } from "@/server/inbox/send";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

/**
 * Campañas masivas (DEMO): envía UNA plantilla aprobada a UN destinatario de
 * la lista. La pantalla recorre el CSV y llama aquí renglón por renglón: así
 * cada envío reporta su resultado y ninguna petición queda abierta minutos.
 *
 * Sin tabla propia a propósito: la campaña vive en la pantalla y cada mensaje
 * queda en la conversación del contacto, igual que una plantilla enviada a
 * mano desde Contactos.
 */
const bodySchema = z.object({
  templateId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  // Mismo criterio que el alta manual de contactos: dígitos con código de país.
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/, "Teléfono en dígitos, con código de país (ej. 5215512345678)"),
  variables: z.array(z.string().trim().max(500)).max(10).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const phone = normalizeMx(body.data.phone);

  const found = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        eq(schema.contact.channel, "whatsapp"),
        eq(schema.contact.waIdentity, phone)
      )
    )
    .limit(1);

  let contactId = found[0]?.id;
  if (!contactId) {
    const inserted = await db
      .insert(schema.contact)
      .values({
        id: newId("contact"),
        organizationId: session.organizationId,
        name: body.data.name,
        phone,
        waIdentity: phone,
      })
      .onConflictDoNothing({
        target: [
          schema.contact.organizationId,
          schema.contact.channel,
          schema.contact.waIdentity,
        ],
      })
      .returning({ id: schema.contact.id });
    contactId = inserted[0]?.id;
    if (!contactId) {
      return apiError(409, "duplicate", "No se pudo registrar el contacto");
    }
    // Un contacto sin lead es invisible en el Pipeline.
    await createLeadForContact({
      organizationId: session.organizationId,
      contactId,
      source: "dueno",
      actorUserId: session.userId,
    });
  }

  const conversation = await getOrCreateConversation(
    session.organizationId,
    contactId
  );
  if (!conversation) {
    return apiError(500, "internal", "No se pudo abrir la conversación");
  }

  try {
    const result = await sendTemplate({
      organizationId: session.organizationId,
      conversationId: conversation.id,
      templateId: body.data.templateId,
      variables: body.data.variables,
    });
    return Response.json({
      messageId: result.messageId,
      conversationId: conversation.id,
    });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(409, err.code, err.message);
    }
    throw err;
  }
});
