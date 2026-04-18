export interface EmlInput {
  subject: string;
  body: string;
  to?: string;
  from?: string;
}

export function buildEml({ subject, body, to, from }: EmlInput): string {
  const lines = [
    `From: ${from ?? ''}`,
    `To: ${to ?? ''}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body,
  ];
  return lines.join('\r\n');
}
