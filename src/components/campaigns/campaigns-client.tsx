"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FileUp, Megaphone, Send, Trash2 } from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import { countVariables, renderBody } from "@/lib/templates";
import { formatPhone } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type RowStatus = "pendiente" | "enviando" | "enviado" | "error" | "invalido";

type Row = {
  name: string;
  phone: string;
  /** Columnas extra del CSV, en orden: valores de {{1}}, {{2}}… */
  extra: string[];
  status: RowStatus;
  detail?: string;
};

const STATUS_BADGE: Record<
  RowStatus,
  { label: string; variant: "secondary" | "warning" | "success" | "destructive" }
> = {
  pendiente: { label: "Pendiente", variant: "secondary" },
  enviando: { label: "Enviando…", variant: "warning" },
  enviado: { label: "Enviado", variant: "success" },
  error: { label: "Error", variant: "destructive" },
  invalido: { label: "Teléfono inválido", variant: "destructive" },
};

const EJEMPLO = "nombre,telefono\nAna López,5215512345678\nLuis Pérez,5214421234567";

/** Tope de la demo: una lista más grande pide cola y reintentos de verdad. */
const MAX_FILAS = 200;

/** Pausa entre envíos, para no chocar con el límite de ritmo de Meta. */
const PAUSA_MS = 400;

/**
 * CSV sencillo: una persona por renglón, `nombre,telefono[,var1,var2…]`.
 * Acepta coma, punto y coma o tabulador (Excel en español exporta con `;`) y
 * se salta el encabezado si lo trae.
 */
function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line
      .split(/[,;\t]/)
      .map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    const name = cells[0] ?? "";
    const phone = (cells[1] ?? "").replace(/\D/g, "");
    if (!phone && /tel|phone|cel|whats|n[uú]mero/i.test(cells[1] ?? "")) continue;
    const valido = /^\d{7,15}$/.test(phone) && name.length > 0;
    rows.push({
      name,
      phone,
      extra: cells.slice(2),
      status: valido ? "pendiente" : "invalido",
    });
  }
  return rows.slice(0, MAX_FILAS);
}

/** Si el CSV no trae columnas de variables, {{1}} es el nombre. */
function variablesFor(row: Row, count: number): string[] {
  const base = row.extra.some((v) => v) ? row.extra : [row.name];
  return Array.from({ length: count }, (_, i) => base[i] ?? "");
}

export function CampaignsClient() {
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [csv, setCsv] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      // Mismo pull que Ajustes → Plantillas: sin él, una plantilla ya aprobada
      // por Meta puede seguir viéndose como pendiente.
      await fetch("/api/templates/sync", { method: "POST" }).catch(() => null);
      const res = await fetch("/api/templates").catch(() => null);
      if (res?.ok) {
        const data = (await res.json()) as { templates: TemplateDto[] };
        const approved = data.templates.filter((t) => t.status === "approved");
        setTemplates(approved);
        setTemplateId((prev) => prev || approved[0]?.id || "");
      }
      setLoaded(true);
    })();
  }, []);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const variableCount = template ? countVariables(template.body) : 0;

  const resumen = useMemo(() => {
    const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
    return {
      total: rows.length,
      pendientes: count("pendiente"),
      enviados: count("enviado"),
      errores: count("error"),
      invalidos: count("invalido"),
    };
  }, [rows]);

  function cargar(text: string) {
    setCsv(text);
    setRows(parseCsv(text));
    setConfirming(false);
  }

  async function leerArchivo(file: File | undefined) {
    if (!file) return;
    cargar(await file.text());
    if (fileRef.current) fileRef.current.value = "";
  }

  function patchRow(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function enviar() {
    if (!template) return;
    setConfirming(false);
    setSending(true);
    cancelRef.current = false;
    const cola = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.status === "pendiente" || row.status === "error");

    for (const { row, index } of cola) {
      if (cancelRef.current) break;
      patchRow(index, { status: "enviando", detail: undefined });
      const res = await fetch("/api/campaigns/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: template.id,
          name: row.name,
          phone: row.phone,
          variables: variableCount > 0 ? variablesFor(row, variableCount) : undefined,
        }),
      }).catch(() => null);

      if (res?.ok) {
        patchRow(index, { status: "enviado" });
      } else {
        const data = (await res?.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        patchRow(index, {
          status: "error",
          detail: data?.error?.message ?? "Sin respuesta del servidor",
        });
      }
      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
    setSending(false);
  }

  const porEnviar = resumen.pendientes + resumen.errores;
  const ejemplo = rows.find((r) => r.status !== "invalido");

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <Megaphone className="h-[18px] w-[18px] text-brand" strokeWidth={1.8} />
        <h2 className="text-[17px] font-bold tracking-tight">
          Campañas masivas de WhatsApp
        </h2>
        <Badge variant="warning">Demo</Badge>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>1. Elige la plantilla</CardTitle>
              <CardDescription>
                WhatsApp solo permite escribirle primero a alguien con una
                plantilla aprobada por Meta.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loaded && templates.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Aún no tienes plantillas aprobadas. Créalas o sincronízalas en{" "}
                  <Link href="/settings/templates" className="font-semibold text-brand-text underline">
                    Ajustes → Plantillas
                  </Link>
                  .
                </p>
              ) : (
                <>
                  <Label htmlFor="campaign-template">Plantilla</Label>
                  <select
                    id="campaign-template"
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                    disabled={sending || !loaded}
                    className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                  >
                    {!loaded && <option value="">Cargando…</option>}
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.language} · {t.category})
                      </option>
                    ))}
                  </select>
                  {template && (
                    <div className="rounded-lg border bg-subtle p-3">
                      <p className="kicker mb-1.5">
                        Vista previa{ejemplo ? ` · ${ejemplo.name}` : ""}
                      </p>
                      <p className="whitespace-pre-wrap text-sm">
                        {ejemplo
                          ? renderBody(template.body, variablesFor(ejemplo, variableCount))
                          : template.body}
                      </p>
                      {variableCount > 0 && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Esta plantilla lleva {variableCount} variable(s). Sin
                          columnas extra en tu lista, {"{{1}}"} es el nombre.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Carga tu lista</CardTitle>
              <CardDescription>
                Un CSV con una persona por renglón: nombre y teléfono con código
                de país. Las columnas que sigan llenan {"{{1}}"}, {"{{2}}"}…
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => void leerArchivo(e.target.files?.[0])}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  onClick={() => fileRef.current?.click()}
                >
                  <FileUp className="h-4 w-4" strokeWidth={1.8} />
                  Subir CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={sending}
                  onClick={() => cargar(EJEMPLO)}
                >
                  Usar ejemplo
                </Button>
                {rows.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={sending}
                    onClick={() => cargar("")}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                    Vaciar
                  </Button>
                )}
              </div>
              <Textarea
                value={csv}
                onChange={(e) => cargar(e.target.value)}
                disabled={sending}
                rows={6}
                placeholder={EJEMPLO}
                aria-label="Lista de contactos en CSV"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Hasta {MAX_FILAS} contactos por campaña en esta demo.
              </p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>3. Revisa y envía</CardTitle>
              <CardDescription>
                {rows.length === 0
                  ? "Aquí verás tu lista antes de enviar."
                  : `${resumen.total} contacto(s) · ${resumen.enviados} enviado(s) · ${resumen.errores} con error · ${resumen.invalidos} inválido(s)`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {rows.length > 0 && (
                <div className="max-h-80 overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-subtle text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Nombre</th>
                        <th className="px-3 py-2 font-semibold">Teléfono</th>
                        <th className="px-3 py-2 font-semibold">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={`${row.phone}-${i}`} className="border-t">
                          <td className="px-3 py-2">{row.name || "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {row.phone ? formatPhone(row.phone) : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={STATUS_BADGE[row.status].variant}>
                              {STATUS_BADGE[row.status].label}
                            </Badge>
                            {row.detail && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {row.detail}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                {sending ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      cancelRef.current = true;
                    }}
                  >
                    Detener
                  </Button>
                ) : confirming ? (
                  <>
                    <Button onClick={() => void enviar()}>
                      <Send className="h-4 w-4" strokeWidth={1.8} />
                      Sí, enviar a {porEnviar}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(false)}>
                      Cancelar
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Son mensajes reales de WhatsApp: Meta cobra cada plantilla.
                    </span>
                  </>
                ) : (
                  <Button
                    disabled={!template || porEnviar === 0}
                    onClick={() => setConfirming(true)}
                  >
                    <Send className="h-4 w-4" strokeWidth={1.8} />
                    {resumen.errores > 0 && resumen.pendientes === 0
                      ? `Reintentar ${porEnviar}`
                      : `Enviar campaña${porEnviar ? ` (${porEnviar})` : ""}`}
                  </Button>
                )}
                {sending && (
                  <span className="text-xs text-muted-foreground">
                    Enviando {resumen.enviados + resumen.errores + 1} de{" "}
                    {resumen.total - resumen.invalidos}…
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
