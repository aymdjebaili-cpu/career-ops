import { readFileSync } from 'fs';
import { google } from 'googleapis';
const P = 'c:/Users/PC/Downloads/career-ops-main/career-ops-main';
const cred = JSON.parse(readFileSync(`${P}/config/gmail-credentials.json`,'utf8'));
const { client_secret, client_id } = cred.installed || cred.web;
const o = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
o.setCredentials(JSON.parse(readFileSync(`${P}/config/gmail-token.json`,'utf8')));
const gmail = google.gmail({version:'v1', auth:o});
const log = JSON.parse(readFileSync(`${P}/output/.draft-log.json`,'utf8'));
for (const key of ['email-373-kayak.md','email-init-gebeco.md']) {
  const id = log[key].draftId;
  const d = await gmail.users.drafts.get({ userId:'me', id, format:'full' });
  const m = d.data.message;
  console.log(`\n===== ${key} (draft ${id}) =====`);
  console.log('snippet:', JSON.stringify(m.snippet));
  console.log('mimeType:', m.payload.mimeType);
  const walk = (part, d=0) => {
    const pad='  '.repeat(d);
    const size = part.body?.size ?? 0;
    console.log(`${pad}- ${part.mimeType} size=${size} filename=${part.filename||''}`);
    if (part.mimeType === 'text/plain' && part.body?.data) {
      const txt = Buffer.from(part.body.data,'base64').toString('utf8');
      console.log(`${pad}  BODY CHARS: ${txt.length}`);
      console.log(`${pad}  FIRST 200: ${JSON.stringify(txt.slice(0,200))}`);
    }
    (part.parts||[]).forEach(p => walk(p, d+1));
  };
  walk(m.payload);
}
