import { BadRequestException } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

/** Valida o corpo da requisição e devolve os erros em português, campo a campo. */
export function validar<T extends ZodTypeAny>(schema: T, dados: unknown): z.infer<T> {
  const r = schema.safeParse(dados);
  if (!r.success) {
    throw new BadRequestException({
      mensagem: 'Confira os campos destacados.',
      campos: Object.fromEntries(r.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  }
  return r.data;
}

export const dataISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
  .refine((d) => {
    const [a, m, dia] = d.split('-').map(Number);
    const x = new Date(Date.UTC(a, m - 1, dia));
    return a >= 1900 && a <= 2200 && x.getUTCMonth() === m - 1 && x.getUTCDate() === dia;
  }, 'Data inválida');
export const centavos = z.number().int('Valor em centavos').min(0);
export const texto = (max = 200) => z.string().trim().max(max);
export const opcional = (max = 200) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
