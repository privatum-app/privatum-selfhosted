import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { lang, setLang, t } from '../i18n.ts';
import { decryptBackup, encryptBackup, MIN_BACKUP_PASSPHRASE, type KeyFiles } from './backup.ts';
import { Icon, Logo, Modal, Qr } from '../ui.tsx';

const MIN_PASSWORD = 10;

const ERRORS: Record<string, string> = {
  wrong_password: t('Senha incorreta.'),
  short_password: t('Use pelo menos {n} caracteres.', { n: MIN_PASSWORD }),
  rate_limited: t('Muitas tentativas. Aguarde um minuto.'),
  already_configured: t('O painel já tem senha. Recarregue a página e entre.'),
  forbidden_host: t('Abra o painel pelo endereço http://127.0.0.1:8099.'),
  tor_unavailable: t('Sem resposta do Tor.'),
  tor_auth_failed: t('O Tor recusou o acesso do painel.'),
  relay_unavailable: t('Sem resposta do relay.'),
  wrong_passphrase: t('Senha do backup incorreta.'),
  bad_backup: t('Este arquivo não é um backup de endereço do Privatum.'),
  bad_key_files: t('O backup está corrompido: a chave não tem o formato do Tor.'),
  key_mismatch: t('O backup está corrompido: a chave não corresponde ao endereço. Nada foi alterado.'),
  bad_hostname: t('O backup tem um endereço inválido. Nada foi alterado.'),
  no_key_yet: t('O Tor ainda não criou a chave. Tente em alguns segundos.'),
  cannot_save: t('Não foi possível gravar a chave.'),
  cannot_delete: t('Não foi possível apagar a chave atual.'),
  bad_invite_limits: t('Use de 1 a 100 usos e de 1 a 30 dias.'),
  too_many_invites: t('Há convites demais ativos. Revogue alguns antes.'),
};
const describe = (code: string) => ERRORS[code] ?? t('Erro: {code}', { code });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    // Required by the server on every change (blocks cross-site request forgery).
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-privatum-admin': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `http_${res.status}`);
  return data as T;
}

interface Status {
  onion: string | null;
  version: string;
  tor: { ok: boolean; progress?: number; summary?: string; error?: string };
  relay: {
    ok: boolean;
    error?: string;
    mailboxes?: number;
    max_mailboxes?: number;
    messages?: number;
    message_bytes?: number;
    db_bytes?: number;
    message_ttl_days?: number;
  };
}

const bytes = (n = 0) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export function Admin() {
  const [session, setSession] = useState<{ configured: boolean; logged_in: boolean } | null>(null);
  const [error, setError] = useState('');
  const refresh = () =>
    api<{ configured: boolean; logged_in: boolean }>('/api/session')
      .then(setSession)
      .catch((e) => setError(describe(e.message)));
  useEffect(() => {
    void refresh();
  }, []);

  if (error) return <Shell><p className="notice danger">{error}</p></Shell>;
  if (!session) return <Shell><p className="muted">{t('Carregando…')}</p></Shell>;
  if (!session.logged_in) return <Shell><Login setup={!session.configured} onDone={refresh} /></Shell>;
  return <Dashboard onLogout={refresh} />;
}

function LangSwitch() {
  return (
    <button className="btn quiet lang-switch" onClick={() => setLang(lang() === 'en' ? 'pt' : 'en')}>
      {lang() === 'en' ? 'Português' : 'English'}
    </button>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="welcome">
      <div className="welcome-mark">
        <h1 className="brandmark">
          <Logo size={72} />
          <span className="wordmark admin-wordmark">{t('Painel')}</span>
        </h1>
        <p className="tagline">{t('Gerenciamento local da sua instância. Só abre neste computador.')}</p>
        <LangSwitch />
      </div>
      {children}
    </main>
  );
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (setup && password.length < MIN_PASSWORD) return setError(ERRORS.short_password);
    if (setup && password !== confirm) return setError(t('As senhas não coincidem.'));
    setBusy(true);
    try {
      await api(setup ? '/api/setup' : '/api/login', { password });
      onDone();
    } catch (err) {
      setError(describe((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel gate" onSubmit={submit}>
      <h2>{setup ? t('Criar a senha do painel') : t('Entrar no painel')}</h2>
      {setup && (
        <p className="muted">
          {t('Primeiro acesso. Esta senha protege o gerenciamento da instância (endereço, chave, contas). Não é a senha das suas conversas.')}
        </p>
      )}
      <label className="field">
        <span>{t('Senha do painel')}</span>
        <input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      {setup && (
        <label className="field">
          <span>{t('Repita a senha')}</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      )}
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t('Conferindo…') : setup ? t('Criar senha e entrar') : t('Entrar')}</button>
    </form>
  );
}

/** What the dashboard waits for after it asked tor to restart with another key. */
interface Restart {
  from: string | null;
  /** Restore: the address that must come back. Rotate: unknown until tor creates it. */
  to?: string;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [restart, setRestart] = useState<Restart | null>(null);
  const restarting =
    restart !== null &&
    !(status?.tor.ok && status.tor.progress === 100 && status.onion && (restart.to ? status.onion === restart.to : status.onion !== restart.from));
  useEffect(() => {
    const load = () =>
      api<Status>('/api/status')
        .then((s) => {
          setStatus(s);
          setError('');
        })
        .catch((e) => (e.message === 'unauthorized' ? onLogout() : setError(describe(e.message))));
    void load();
    // Poll faster while tor restarts, so the new address shows up as soon as it exists.
    const timer = setInterval(load, restarting ? 2_000 : 10_000);
    return () => clearInterval(timer);
  }, [onLogout, restarting]);

  const logout = async () => {
    await api('/api/logout', {}).catch(() => {});
    onLogout();
  };

  return (
    <div className="admin">
      <header className="admin-head">
        <div className="brandmark">
          <Logo size={30} />
          <strong>{t('Privatum')}</strong>
          <span className="muted">{t('Painel')}</span>
        </div>
        <LangSwitch />
        <button className="icon-btn" title={t('Sair do painel')} aria-label={t('Sair do painel')} onClick={logout}>
          <Icon name="logout" />
        </button>
      </header>
      {error && !restarting && <p className="notice danger" role="alert">{error}</p>}
      {restarting && (
        <p className="notice warn" role="status">
          {restart?.to ? t('Reiniciando o Tor com a chave restaurada… Leva de alguns segundos a um minuto.') : t('Reiniciando o Tor com a chave nova… Leva de alguns segundos a um minuto.')}
        </p>
      )}
      {restart && !restarting && (
        <p className="notice ok" role="status">
          {t('Pronto: a instância responde em {onion}. A rede Tor pode levar alguns minutos para encontrar o endereço.', { onion: status?.onion ?? '' })}
        </p>
      )}
      {!status ? (
        <p className="muted">{t('Carregando…')}</p>
      ) : (
        <div className="admin-grid">
          <Address onion={status.onion} />
          {/* Status and the key mark share a column, filling the space beside the taller address card. */}
          <div className="admin-col">
            <Health status={status} />
            <section className="panel card brand-card" aria-hidden="true">
              <Logo size={150} />
            </section>
          </div>
          <Usage relay={status.relay} />
          <OnionKey onion={status.onion} onRestart={(to) => setRestart({ from: status.onion, to })} />
          {status.relay.ok && <Access />}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Address({ onion }: { onion: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!onion) {
    return (
      <Card title={t('Endereço da instância')}>
        <p className="muted">{t('O Tor ainda está criando o endereço. Isso leva alguns segundos na primeira vez.')}</p>
      </Card>
    );
  }
  const url = `http://${onion}`;
  return (
    <Card title={t('Endereço da instância')}>
      <code className="onion">{url}</code>
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <Icon name={copied ? 'check' : 'link'} /> {copied ? t('Copiado') : t('Copiar endereço')}
        </button>
      </div>
      <Qr text={url} />
      <p className="hint">
        {t('Abra no Tor Browser (nível Standard) e crie sua identidade. Para convidar alguém, use “Meu convite” dentro do app, não este endereço sozinho.')}
      </p>
    </Card>
  );
}

function Health({ status }: { status: Status }) {
  const { tor, relay } = status;
  const torReady = tor.ok && tor.progress === 100;
  return (
    <Card title={t('Status')}>
      <dl className="kv">
        <dt>{t('Tor')}</dt>
        <dd>
          {tor.ok ? (
            <span className={`tag ${torReady ? 'ok' : 'warn'}`}>{torReady ? t('conectado') : t('conectando {p}%', { p: tor.progress ?? 0 })}</span>
          ) : (
            <span className="tag warn">{describe(tor.error ?? '')}</span>
          )}
        </dd>
        <dt>{t('Relay')}</dt>
        <dd>
          <span className={`tag ${relay.ok ? 'ok' : 'warn'}`}>{relay.ok ? t('no ar') : describe(relay.error ?? '')}</span>
        </dd>
        <dt>{t('Versão')}</dt>
        <dd className="mono">{status.version}</dd>
      </dl>
      {tor.ok && !torReady && tor.summary && <p className="hint">{tor.summary}</p>}
    </Card>
  );
}

function Usage({ relay }: { relay: Status['relay'] }) {
  if (!relay.ok) return null;
  return (
    <Card title={t('Uso')}>
      <dl className="kv">
        <dt>{t('Pessoas registradas')}</dt>
        <dd>
          {relay.mailboxes} <span className="muted">{t('de')}{' '}{relay.max_mailboxes}</span>
        </dd>
        <dt>{t('Mensagens aguardando entrega')}</dt>
        <dd>
          {relay.messages} <span className="muted">({bytes(relay.message_bytes)})</span>
        </dd>
        <dt>{t('Banco de dados')}</dt>
        <dd>{bytes(relay.db_bytes)}</dd>
        <dt>{t('Mensagens não entregues expiram em')}</dt>
        <dd>{t('{n} dias', { n: relay.message_ttl_days ?? 0 })}</dd>
      </dl>
      <p className="hint">{t('Só contagens: o painel não vê conteúdo, nomes nem quem conversa com quem.')}</p>
    </Card>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The key leaves the container only to this browser, which encrypts it before saving. */
async function exportBackup(passphrase: string) {
  const files = await api<KeyFiles>('/api/onion/export', {});
  const name = `privatum-endereco-${files.hostname.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.privatum-onion`;
  download(name, await encryptBackup(files, passphrase));
}

function OnionKey({ onion, onRestart }: { onion: string | null; onRestart: (to?: string) => void }) {
  const [dialog, setDialog] = useState<'backup' | 'restore' | 'rotate' | null>(null);
  const close = () => setDialog(null);
  return (
    <Card title={t('Chave do endereço')}>
      <p className="muted">
        {t('O endereço .onion vem desta chave. Guarde um backup fora deste computador: sem ele, perder a chave muda o endereço e quebra todos os convites.')}
      </p>
      <div className="row">
        <button className="btn primary" disabled={!onion} onClick={() => setDialog('backup')}>
          <Icon name="download" />{' '}{t('Baixar backup')}
        </button>
        <button className="btn quiet" onClick={() => setDialog('restore')}>{t('Restaurar backup')}</button>
        <button className="btn quiet danger-text" disabled={!onion} onClick={() => setDialog('rotate')}>{t('Trocar endereço')}</button>
      </div>
      <Modal open={dialog === 'backup'} onClose={close} title={t('Baixar backup da chave')}>
        <BackupForm onDone={close} />
      </Modal>
      <Modal open={dialog === 'restore'} onClose={close} title={t('Restaurar backup da chave')}>
        <RestoreForm
          onDone={(to) => {
            close();
            onRestart(to);
          }}
        />
      </Modal>
      <Modal open={dialog === 'rotate'} onClose={close} title={t('Trocar o endereço .onion')}>
        <RotateForm
          onBackup={() => setDialog('backup')}
          onDone={() => {
            close();
            onRestart();
          }}
        />
      </Modal>
    </Card>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(describe((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function BackupForm({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, setError, run } = useAction();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (pass.length < MIN_BACKUP_PASSPHRASE) return setError(t('Use pelo menos {n} caracteres.', { n: MIN_BACKUP_PASSPHRASE }));
        if (pass !== confirm) return setError(t('As senhas não coincidem.'));
        void run(async () => {
          await exportBackup(pass);
          onDone();
        });
      }}
    >
      <p className="muted">
        {t('O arquivo sai cifrado com esta senha, que não fica guardada em lugar nenhum. Quem tiver o arquivo')}{' '}<strong>{t('e')}</strong>{' '}{t('a senha pode se passar pela sua instância.')}
      </p>
      <label className="field">
        <span>{t('Senha do backup')}</span>
        <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('Repita a senha')}</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t('Cifrando…') : t('Baixar backup cifrado')}</button>
    </form>
  );
}

function RestoreForm({ onDone }: { onDone: (to: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const { busy, error, setError, run } = useAction();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return setError(t('Escolha o arquivo de backup.'));
        void run(async () => {
          const files = await decryptBackup(await file.text(), pass);
          await api('/api/onion/restore', files);
          onDone(files.hostname);
        });
      }}
    >
      <p className="muted">
        {t('A instância volta a responder no endereço do backup. A chave atual é substituída: se você não tiver backup dela, o endereço atual se perde.')}
      </p>
      <label className="field">
        <span>{t('Arquivo (.privatum-onion)')}</span>
        <input type="file" accept=".privatum-onion" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="field">
        <span>{t('Senha do backup')}</span>
        <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t('Conferindo a chave…') : t('Restaurar e reiniciar o Tor')}</button>
    </form>
  );
}

function RotateForm({ onBackup, onDone }: { onBackup: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api('/api/onion/rotate', { confirm: typed });
          onDone();
        });
      }}
    >
      <p className="notice danger">
        {t('A chave atual é apagada e o Tor cria um endereço novo.')}{' '}<strong>{t('Todos os convites param de funcionar')}</strong>{' '}{t('e cada pessoa precisa restaurar o próprio backup do Privatum no endereço novo. Sem um backup da chave, não há como voltar ao endereço atual.')}
      </p>
      <button type="button" className="btn quiet" onClick={onBackup}>
        <Icon name="download" />{' '}{t('Baixar backup da chave atual antes')}
      </button>
      <label className="field">
        <span>{t('Para confirmar, digite TROCAR')}</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn danger" disabled={busy || typed !== 'TROCAR'}>{busy ? t('Trocando…') : t('Apagar a chave e trocar o endereço')}</button>
    </form>
  );
}

interface AccessData {
  registration: 'open' | 'invite' | 'closed';
  invites: { id: string; by_admin: boolean; created_at: number; expires_at: number; uses_left: number }[];
  mailboxes: { id: string; created_at: number; pending: number }[];
}

const date = (unix: number) => new Date(unix * 1000).toLocaleDateString(lang() === 'en' ? 'en-US' : 'pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const MODES: { value: AccessData['registration']; label: string; help: string }[] = [
  { value: 'open', label: t('Aberta'), help: t('Qualquer pessoa que tenha o endereço pode criar uma identidade aqui.') },
  {
    value: 'invite',
    label: t('Só convidados'),
    help: t('Precisa de um código: o “Meu convite” de quem já participa leva um (uso único, 7 dias), ou um convite criado aqui.'),
  },
  { value: 'closed', label: t('Fechada'), help: t('Ninguém novo entra. Quem já participa continua normalmente.') },
];

/** Grid wraps cards, so this one spans the full width to fit its tables. */
function Access() {
  const [data, setData] = useState<AccessData | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api<AccessData>('/api/access')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(describe(e.message)));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return error ? <p className="notice danger">{error}</p> : null;
  const adminInvites = data.invites.filter((i) => i.by_admin);
  const memberInvites = data.invites.length - adminInvites.length;
  return (
    <>
      <Card title={t('Quem pode entrar')}>
        <div className="modes" role="radiogroup" aria-label={t('Quem pode criar identidade nesta instância')}>
          {MODES.map((mode) => (
            <label key={mode.value} className={`mode ${data.registration === mode.value ? 'active' : ''}`}>
              <input
                type="radio"
                name="registration"
                value={mode.value}
                checked={data.registration === mode.value}
                onChange={() => api('/api/access/registration', { mode: mode.value }).then(load, (e) => setError(describe(e.message)))}
              />
              <span>
                <strong>{mode.label}</strong>
                <span className="hint">{mode.help}</span>
              </span>
            </label>
          ))}
        </div>
        {error && <p className="notice danger" role="alert">{error}</p>}
      </Card>
      <Invites adminInvites={adminInvites} memberInvites={memberInvites} registration={data.registration} onChange={load} />
      <Accounts mailboxes={data.mailboxes} onChange={load} />
    </>
  );
}

function Invites({
  adminInvites,
  memberInvites,
  registration,
  onChange,
}: {
  adminInvites: AccessData['invites'];
  memberInvites: number;
  registration: AccessData['registration'];
  onChange: () => void;
}) {
  const [uses, setUses] = useState(1);
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Card title={t('Convites do painel')}>
      {registration !== 'invite' && <p className="hint">{t('Os códigos só são exigidos no modo “Só convidados”.')}</p>}
      <form
        className="invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ link: string }>('/api/access/invites', { uses, days });
            setCreated(r.link);
            setCopied(false);
            onChange();
          });
        }}
      >
        <label className="field">
          <span>{t('Usos')}</span>
          <input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>{t('Vale por (dias)')}</span>
          <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <button className="btn primary" disabled={busy}>{t('Criar convite')}</button>
      </form>
      {error && <p className="notice danger" role="alert">{error}</p>}
      {created && (
        <div className="stack">
          <p className="notice ok">{t('Copie agora: o link não é mostrado de novo (a instância guarda só uma impressão do código).')}</p>
          <code className="onion">{created}</code>
          <div className="row">
            <button
              className="btn quiet"
              onClick={async () => {
                await navigator.clipboard.writeText(created);
                setCopied(true);
              }}
            >
              <Icon name={copied ? 'check' : 'link'} /> {copied ? t('Copiado') : t('Copiar link')}
            </button>
          </div>
          <Qr text={created} />
          <p className="hint">{t('Quem abrir este link no Tor Browser cria a identidade já com o código. Ele não adiciona você como contato.')}</p>
        </div>
      )}
      {adminInvites.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Código')}</th>
              <th>{t('Usos restantes')}</th>
              <th>{t('Expira')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {adminInvites.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.id.slice(0, 8)}…</td>
                <td>{i.uses_left}</td>
                <td>{date(i.expires_at)}</td>
                <td>
                  <button className="btn quiet danger-text small" onClick={() => api('/api/access/invites/revoke', { id: i.id }).then(onChange)}>
                    {t('Revogar')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {memberInvites > 0 && <p className="hint">{t('Mais {n} convite(s) de membros ainda não usado(s).', { n: memberInvites })}</p>}
    </Card>
  );
}

function Accounts({ mailboxes, onChange }: { mailboxes: AccessData['mailboxes']; onChange: () => void }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card title={t('Contas ({n})', { n: mailboxes.length })}>
      <p className="hint">
        {t('Cada conta aparece só pelo identificador da caixa (o mesmo que vai no convite da pessoa). O painel não sabe nomes nem quem conversa com quem.')}
      </p>
      {mailboxes.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Caixa')}</th>
              <th>{t('Criada')}</th>
              <th>{t('Aguardando')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((mb) => (
              <tr key={mb.id}>
                <td className="mono" title={mb.id}>{mb.id.slice(0, 10)}…</td>
                <td>{date(mb.created_at)}</td>
                <td>{mb.pending}</td>
                <td>
                  <button className="btn quiet danger-text small" onClick={() => setRemoving(mb.id)}>{t('Remover')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={removing !== null} onClose={() => setRemoving(null)} title={t('Remover conta')}>
        <div className="stack">
          <p className="muted">
            {t('Apaga desta instância a caixa')}{' '}<code className="mono">{removing?.slice(0, 10)}…</code>{t(', as chaves públicas dela e as mensagens que ainda esperavam entrega. Os contatos deixam de conseguir escrever para ela. As conversas guardadas no navegador da pessoa não são apagadas.')}
          </p>
          <p className="hint">{t('Com a instância aberta, a pessoa pode voltar sozinha; nos outros modos, precisa de um convite novo.')}</p>
          {error && <p className="notice danger" role="alert">{error}</p>}
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('/api/access/mailboxes/remove', { id: removing });
                setRemoving(null);
                onChange();
              })
            }
          >
            {t('Remover conta')}
          </button>
        </div>
      </Modal>
    </Card>
  );
}
