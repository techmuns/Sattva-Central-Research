// Offline shared-source lock. Optional peer verification never fetches a repository or calls a provider.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const contract=JSON.parse(readFileSync(new URL('../docs/NEWSLETTER-SHARED-SOURCE.json',import.meta.url),'utf8'));
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const canonical=text=>text.replaceAll('Glow Ventures','Family Office').replaceAll('Sattva Ventures','Family Office')
 .replaceAll('GLOW VENTURES','FAMILY OFFICE').replaceAll('SATTVA VENTURES','FAMILY OFFICE')
 .replaceAll('Glow-Central-Research','Central-Research').replaceAll('Sattva-Central-Research','Central-Research')
 .replaceAll('glow-central-research.tech-441.workers.dev','central-research.example')
 .replaceAll('sattva-central-research.tech-441.workers.dev','central-research.example')
 .replaceAll('GlowCentralResearch/1.0','ResearchBot/1.0').replaceAll('SattvaCentralResearch/1.0','ResearchBot/1.0')
 .replaceAll('GlowResearch/1.0','ResearchBot/1.0').replaceAll('SattvaCentralBot/1.0','ResearchBot/1.0')
 .replaceAll('`glow-${brief.day}','`family-${brief.day}').replaceAll('`sattva-${brief.day}','`family-${brief.day}');
assert.match(contract.initialGlowRevision,/^[a-f0-9]{40}$/);
assert.equal(contract.schemaVersion,1);assert.equal(contract.upstream,'techmuns/Sattva-Central-Research');
const roots=[root,...(process.env.NEWSLETTER_PEER_ROOT?[resolve(process.env.NEWSLETTER_PEER_ROOT)]:[])];
for(const directory of roots)for(const [file,expected] of Object.entries(contract.files)){
 assert.match(file,/^(?:public\/js\/data\/newsletter-shared\.js|worker\/newsletter-[a-z-]+\.mjs|scripts\/(?:collect-newsletter|newsletter-wake-gate|verify-newsletter|verify-newsletter-(?:parity|output|investments|investor|events|source-links|company-reading|pdf))\.mjs|scripts\/lib\/newsletter-[a-z-]+\.mjs|scripts\/fixtures\/newsletter\/[a-z0-9-]+\.(?:json|xml))$/);
 assert.match(expected,/^[a-f0-9]{64}$/);
 const hash=createHash('sha256').update(canonical(readFileSync(resolve(directory,file),'utf8'))).digest('hex');
 assert.equal(hash,expected,`Shared newsletter source drift: ${file}. Port the shared change and update the shared lock in both repositories.`);
}
console.log(`PASS shared newsletter contract: ${Object.keys(contract.files).length} files, ${roots.length} checkout(s), deployment branding normalized; network/model/mail calls=0`);
