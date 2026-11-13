import { useState, useEffect, useRef } from 'react';
import { readPackService, writePackService, type PackServiceSettings as Settings } from '../settings';
import { PackService, serviceAddress, isInsecureTransport, validateUploads, uploadSizeNote, type UploadProgress } from './service';
import { importBundle } from './bundle';
import { formatBytes } from './download';
import { describeError } from '../errors';
export default function PackServiceSettings() {
  const [settings,setSettings] = useState<Settings>(readPackService);
  const [files,setFiles] = useState<File[]>([]);
  const [region,setRegion] = useState('');
  const [id,setId] = useState('');
  const [message,setMessage] = useState('');
  const [stage,setStage] = useState('');
  const [sent,setSent] = useState<UploadProgress | null>(null);
  const [busy,setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => controller.current?.abort(),[]);
  const update = (next: Settings) => { setSettings(next); setMessage(writePackService(next) ?? ''); };
  let problem: string | null = null;
  let insecure = false;
  try { insecure = isInsecureTransport(serviceAddress(settings)); } catch (e) { problem = (e as Error).message; }
  // Preflight runs on every render of the chosen set, not at submit time: the
  // refusal belongs next to the Remove buttons that can fix it, before any
  // bytes move. `describeError` rather than `(e as Error).message` — see errors.ts.
  let pick: string | null = null;
  try { if (files.length) validateUploads(files); } catch (e) { pick = describeError(e); }
  const sizeNote = files.length ? uploadSizeNote(files) : null;
  /** The tail both entry points share: wait for the build, then verify and install it. */
  const install = async (service: PackService, ctrl: AbortController, buildId: string) => {
    setStage('Waiting for the build to finish');
    await service.poll(buildId,{ signal: ctrl.signal,onProgress: (s) => setStage(`Building — ${s.stages.filter((st) => st.state === 'done').length} of ${s.stages.length} stages done`) });
    setStage('Downloading and verifying the bundle');
    const installed = await importBundle(await service.download(buildId,ctrl.signal));
    setMessage(`${installed.name} installed. Open Regions to view it.`);
  };
  const run = async (go: (service: PackService, ctrl: AbortController) => Promise<string>) => {
    const ctrl = new AbortController(); controller.current = ctrl; setBusy(true); setMessage(''); setSent(null);
    const service = new PackService(settings);
    try { await install(service, ctrl, await go(service, ctrl)); }
    catch (e) { setMessage(ctrl.signal.aborted ? 'Cancelled.' : describeError(e)); }
    finally { setBusy(false); setSent(null); setStage(''); controller.current = null; }
  };
  return <section aria-label="Pack service" className="hint-card">
    <h2>Pack service</h2>
    <p>Self-hosted build service for map bundles. Provide your server address and API key. The key stays on this device.</p>
    <label className="field">Server address<input required type="url" value={settings.url} placeholder="https://packs.example.org" onChange={(e) => update({ ...settings,url: e.target.value })} autoCapitalize="none" autoComplete="off" spellCheck={false} /></label>
    <label className="field">API key<input required type="password" value={settings.apiKey} onChange={(e) => update({ ...settings,apiKey: e.target.value })} autoComplete="off" spellCheck={false} /></label>
    <p>Choose one or more .osm.pbf extracts — adjacent regions belong in one build — and upload them to your server. A finished build can also be retrieved by its id, and a downloaded .tar.gz bundle imported directly.</p>
    <input type="file" accept=".pbf,application/octet-stream" multiple hidden ref={fileRef} onChange={(e) => {
      const chosen = Array.from(e.target.files ?? []);
      // Reset so re-picking the same file fires again.
      e.target.value = '';
      // Re-picking a name replaces its earlier pick rather than stacking a
      // duplicate: the service refuses duplicate input names, and a silent
      // second copy is never what the picker meant.
      setFiles((cur) => [...cur.filter((c) => !chosen.some((f) => f.name === c.name)), ...chosen]);
    }} />
    <div className="region-actions">
      <button className="pill-btn" disabled={busy} onClick={() => fileRef.current?.click()}>Choose .osm.pbf files</button>
    </div>
    {files.map((f, i) => (
      <div key={`${f.name}:${i}`} className="field-row" style={{ margin: '8px 0' }}>
        <span className="truncate" style={{ flex: 1, alignSelf: 'center' }} title={f.name}>{f.name}</span>
        <span style={{ alignSelf: 'center' }}>{formatBytes(f.size)}</span>
        <button className="text-btn" disabled={busy} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name} from the upload`}>Remove</button>
      </div>
    ))}
    {files.length > 0 && <label className="field">Region name (optional)<input value={region} maxLength={200} onChange={(e) => setRegion(e.target.value)} placeholder="prairies" autoComplete="off" spellCheck={false} /></label>}
    {pick && <p role="status">{pick}</p>}
    {sizeNote && <p role="status">{sizeNote}</p>}
    <div className="region-actions">
      <button className="pill-btn" disabled={busy || !!problem || !!pick || !files.length} onClick={() => void run(async (service, ctrl) => {
        setStage('Uploading the map extracts');
        return (await service.submit(files,{ region,signal: ctrl.signal,onProgress: setSent })).id;
      })}>Upload and build</button>
    </div>
    {busy && (
      <div style={{ margin: '16px 0' }}>
        {/* The stage line is the live region; the byte count is not — it changes
            hundreds of times during a send, and announcing it is the firehose the
            RegionsScreen download card exists to avoid. The number lives in the
            progressbar's value text, queryable but never announced. */}
        <div className="progress-stage" role="status" aria-live="polite" aria-atomic="true">{stage}</div>
        {sent && (
          <>
            <div
              className="bar"
              role="progressbar"
              aria-label="Uploading the map extracts"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={sent.fraction === null ? undefined : Math.round(sent.fraction * 100)}
              aria-valuetext={sent.total !== null ? `${formatBytes(sent.sent)} of ${formatBytes(sent.total)}` : `${formatBytes(sent.sent)} uploaded, total size unknown`}
            >
              <div
                className={sent.fraction === null ? 'fill anim' : 'fill'}
                style={sent.fraction === null ? undefined : { width: `${Math.round(sent.fraction * 100)}%` }}
              />
            </div>
            <div className="progress-pct">
              {formatBytes(sent.sent)}
              {sent.total !== null ? ` of ${formatBytes(sent.total)} · ${Math.round((sent.fraction ?? 0) * 100)}%` : ' (size unknown)'}
            </div>
          </>
        )}
        <button className="pill-btn" onClick={() => controller.current?.abort()}>Cancel</button>
      </div>
    )}
    <p>Retrieving a build made elsewhere (for example with curl, adjacent extracts in one submit) needs only its build id.</p>
    <label className="field">Build id<input value={id} onChange={(e) => setId(e.target.value.trim())} autoComplete="off" spellCheck={false} /></label>
    {problem && <p>{problem}</p>}
    {insecure && <p role="status" style={{ color: '#F0B45A' }}>Plain HTTP — the API key is sent unencrypted. Use this only on a network you trust.</p>}
    <button className="pill-btn" disabled={busy || !!problem || !id} onClick={() => void run(async () => id)}>Download build</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
