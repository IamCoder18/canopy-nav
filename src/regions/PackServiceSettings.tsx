import { useState, useEffect, useRef } from 'react';
import { readPackService, writePackService, type PackServiceSettings as Settings } from '../settings';
import { PackService, serviceAddress } from './service';
import { importBundle } from './bundle';
export default function PackServiceSettings() {
  const [settings,setSettings] = useState<Settings>(readPackService);
  const [id,setId] = useState(''); const [message,setMessage] = useState(''); const [busy,setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(),[]);
  const update = (next: Settings) => { setSettings(next); setMessage(writePackService(next) ?? ''); };
  let problem: string | null = null; try { serviceAddress(settings); } catch (e) { problem = (e as Error).message; }
  return <section aria-label="Pack service" className="hint-card">
    <h2>Pack service</h2>
    <p>Self-hosted over HTTPS, including public IPv6 through Caddy. Provide your server address and API key. The key stays on this device.</p>
    <label className="field">Server address<input required type="url" value={settings.url} placeholder="https://packs.example.org" onChange={(e) => update({ ...settings,url: e.target.value })} autoCapitalize="none" autoComplete="off" spellCheck={false} /></label>
    <label className="field">API key<input required type="password" value={settings.apiKey} onChange={(e) => update({ ...settings,apiKey: e.target.value })} autoComplete="off" spellCheck={false} /></label>
    <p>Submit PBF files with curl (adjacent regions in one build), then enter its build id here. You can also import a downloaded .tar.gz bundle.</p>
    <label className="field">Build id<input value={id} onChange={(e) => setId(e.target.value.trim())} autoComplete="off" spellCheck={false} /></label>
    {problem && <p>{problem}</p>}
    <button className="pill-btn" disabled={busy || !!problem || !id} onClick={async () => {
      const ctrl = new AbortController(); controller.current = ctrl; setBusy(true); setMessage('Checking build…');
      try { const service = new PackService(settings); await service.poll(id,{ signal: ctrl.signal,onProgress: (s) => setMessage(`Build ${s.state}: ${s.stages.filter((s) => s.state === 'done').length}/7 stages`) }); setMessage('Downloading and verifying bundle…'); const region = await importBundle(await service.download(id,ctrl.signal)); setMessage(`${region.name} installed. Open Regions to view it.`); }
      catch (e) { setMessage(ctrl.signal.aborted ? 'Download cancelled.' : (e as Error).message); }
      finally { setBusy(false); controller.current = null; }
    }}>Download build</button>
    {busy && <button className="pill-btn" onClick={() => controller.current?.abort()}>Cancel</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
