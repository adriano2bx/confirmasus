/**
 * Formatador do formato texto de exposição do Prometheus (0.0.4).
 * Somente IDs técnicos e nomes de fila/equipe em rótulos; nunca conteúdo, telefone ou nome.
 */

export type MetricType = 'gauge' | 'counter';

export interface MetricSample {
  labels?: Readonly<Record<string, string>>;
  value: number;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: readonly MetricSample[];
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function formatSampleValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

export function formatPrometheus(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    if (!METRIC_NAME.test(family.name)) throw new Error(`Nome de métrica inválido: ${family.name}`);
    if (seen.has(family.name)) throw new Error(`Métrica duplicada: ${family.name}`);
    seen.add(family.name);
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const entries = Object.entries(sample.labels ?? {});
      for (const [label] of entries) {
        if (!LABEL_NAME.test(label) || label.startsWith('__')) {
          throw new Error(`Rótulo inválido: ${label}`);
        }
      }
      const labels = entries.length
        ? `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`
        : '';
      lines.push(`${family.name}${labels} ${formatSampleValue(sample.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Idade em segundos (>= 0) de um instante; 0 quando não há item. */
export function ageSeconds(since: Date | null | undefined, now: Date): number {
  if (!since) return 0;
  return Math.max(0, Math.round((now.getTime() - since.getTime()) / 1_000));
}
