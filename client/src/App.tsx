import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { inviteLink, parseInvite, safetyCode } from './core/identity.ts';
import { KeyMismatchError, Messenger, type Deps } from './core/messenger.ts';
import { loadOlm, storage } from './platform.ts';

const MIN_PASSPHRASE = 12;

const ERRORS: Record<string, string> = {
  identity_mismatch: 'As chaves entregues pelo servidor NÃO correspondem ao convite. Conversa bloqueada.',
  bad_key_signature: 'A chave do contato tem assinatura inválida. Conversa bloqueada.',
  bad_invite: 'Convite inválido.',
  not_found: 'Esse contato não existe nesta instância.',
  no_keys: 'O contato ainda não publicou chaves. Tente mais tarde.',
  instance_full: 'Esta instância atingiu o limite de pessoas.',
  rate_limited: 'Muitas tentativas. Aguarde um pouco.',
};

const describe = (e: unknown) => {
  const code = e instanceof Error ? e.message : String(e);
  return ERRORS[code] ?? (e instanceof KeyMismatchError ? ERRORS.identity_mismatch : `Erro: ${code}`);
};

export function App() {
  const [deps, setDeps] = useState<Deps | null>(null);
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null);
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  // Read the invite once, then drop it from the address bar.
  const [pendingInvite, setPendingInvite] = useState(() => parseInvite(location.hash));
  const [error, setError] = useState('');

  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname);
    loadOlm()
      .then(async (olm) => {
        setDeps({ olm, storage, base: location.origin, host: location.host });
        setHasIdentity(await Messenger.exists(storage));
      })
      .catch(() =>
        setError('Não foi possível carregar a criptografia (WebAssembly). No Tor Browser, use o nível de segurança "Standard".'),
      );
  }, []);

  if (error) return <Shell><p className="error">{error}</p></Shell>;
  if (!deps || hasIdentity === null) return <Shell><p className="muted">Carregando…</p></Shell>;
  if (!messenger) {
    return (
      <Shell>
        <Gate isNew={!hasIdentity} deps={deps} onReady={setMessenger} />
      </Shell>
    );
  }
  return <Chat m={messenger} pendingInvite={pendingInvite} clearInvite={() => setPendingInvite(null)} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="shell">
      <h1 className="brand">Privatum</h1>
      {children}
    </main>
  );
}

function Gate({ isNew, deps, onReady }: { isNew: boolean; deps: Deps; onReady: (m: Messenger) => void }) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (isNew && pass.length < MIN_PASSPHRASE) return setError(`Use pelo menos ${MIN_PASSPHRASE} caracteres.`);
    if (isNew && pass !== confirm) return setError('As senhas não coincidem.');
    setBusy(true);
    try {
      onReady(isNew ? await Messenger.create(pass, deps) : await Messenger.unlock(pass, deps));
    } catch (err) {
      setError((err as { name?: string } | null)?.name === 'OperationError' ? 'Senha incorreta.' : describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{isNew ? 'Criar identidade neste dispositivo' : 'Desbloquear'}</h2>
      {isNew && (
        <p className="muted">
          A senha cifra suas chaves e conversas só neste navegador. Ela nunca é enviada ao servidor e{' '}
          <strong>não pode ser recuperada</strong>.
        </p>
      )}
      <label>
        Senha local
        <input type="password" autoComplete={isNew ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
      </label>
      {isNew && (
        <label>
          Confirmar senha
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Derivando chave…' : isNew ? 'Criar' : 'Entrar'}</button>
    </form>
  );
}

function Chat({ m, pendingInvite, clearInvite }: { m: Messenger; pendingInvite: string | null; clearInvite: () => void }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  useEffect(() => m.subscribe(rerender), [m]);

  const contact = selected ? m.contact(selected) : undefined;
  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <span className="brand small">Privatum</span>
          <button className="ghost" onClick={() => setShowInvite((v) => !v)}>Meu convite</button>
        </header>
        {showInvite && <MyInvite mailbox={m.mailbox} />}
        <AddContact m={m} initial={pendingInvite} onAdded={(mb) => { clearInvite(); setSelected(mb); }} />
        <ul className="contacts">
          {m.contacts.map((c) => (
            <li key={c.mailbox}>
              <button className={c.mailbox === selected ? 'contact active' : 'contact'} onClick={() => setSelected(c.mailbox)}>
                <span>{c.name}</span>
                {c.verified ? <span className="badge ok">verificado</span> : !c.addedByMe && <span className="badge warn">não verificado</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="conversation">
        {contact ? <Conversation m={m} mailbox={contact.mailbox} /> : <p className="muted center">Escolha ou adicione um contato.</p>}
      </section>
    </div>
  );
}

function MyInvite({ mailbox }: { mailbox: string }) {
  const link = inviteLink(location.origin, mailbox);
  return (
    <div className="card invite">
      <p className="muted">Envie este link por um canal em que você confia. Ele leva o endereço desta instância e a impressão digital da sua chave.</p>
      <code className="mono break">{link}</code>
      <button onClick={() => navigator.clipboard.writeText(link)}>Copiar</button>
    </div>
  );
}

function AddContact({ m, initial, onAdded }: { m: Messenger; initial: string | null; onAdded: (mailbox: string) => void }) {
  const [text, setText] = useState(initial ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const mailbox = parseInvite(text);
    if (!mailbox) return setError(ERRORS.bad_invite);
    setBusy(true);
    try {
      await m.addContact(mailbox, name.trim() || `Contato ${mailbox.slice(0, 6)}`);
      setText('');
      setName('');
      onAdded(mailbox);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add" onSubmit={submit}>
      <input placeholder="Cole o link de convite" value={text} onChange={(e) => setText(e.target.value)} />
      <input placeholder="Nome (só neste dispositivo)" value={name} onChange={(e) => setName(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy || !text}>{busy ? 'Verificando chaves…' : 'Adicionar'}</button>
    </form>
  );
}

function Conversation({ m, mailbox }: { m: Messenger; mailbox: string }) {
  const c = m.contact(mailbox)!;
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    safetyCode(m.mailbox, mailbox).then(setCode);
  }, [m, mailbox]);
  // Braces matter: newer browsers return a Promise from scrollIntoView, which
  // React would then try to call as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [c.messages.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setError('');
    const t = text;
    setText('');
    try {
      await m.send(mailbox, t);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      <header className="conv-head">
        <h2>{c.name}</h2>
        <details>
          <summary>Código de segurança</summary>
          <p className="muted">Compare com o contato por voz ou pessoalmente. Se for igual nos dois aparelhos, marque como verificado.</p>
          <code className="mono code">{code}</code>
          <label className="check">
            <input type="checkbox" checked={c.verified} onChange={(e) => m.setVerified(mailbox, e.target.checked)} />
            Conferi o código com {c.name}
          </label>
        </details>
      </header>
      {!c.addedByMe && !c.verified && (
        <p className="banner">Esta pessoa iniciou a conversa sem que você adicionasse o convite dela. Confira o código de segurança.</p>
      )}
      <div className="messages">
        {c.messages.map((msg, i) => (
          <div key={i} className={msg.out ? 'bubble out' : 'bubble in'}>
            <p>{msg.text}</p>
            <time className="muted">{new Date(msg.at).toLocaleTimeString()}{msg.failed ? ' · não enviada' : ''}</time>
          </div>
        ))}
        <div ref={end} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem" maxLength={4000} aria-label="Mensagem" />
        <button>Enviar</button>
      </form>
    </>
  );
}
