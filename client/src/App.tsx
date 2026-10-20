import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { inviteLink, parseInvite, safetyCode } from './core/identity.ts';
import { KeyMismatchError, Messenger, type Contact, type Deps } from './core/messenger.ts';
import { loadOlm, storage } from './platform.ts';
import { Icon, Modal, Sigil } from './ui.tsx';

const MIN_PASSPHRASE = 12;
const BRAND_SEED = 'privatumonionsigilbrandmark';

const ERRORS: Record<string, string> = {
  bad_backup: 'Este arquivo não é um backup do Privatum.',
  identity_mismatch: 'As chaves entregues pela instância não correspondem ao convite. Conversa bloqueada por segurança.',
  bad_key_signature: 'A chave do contato tem assinatura inválida. Conversa bloqueada por segurança.',
  bad_invite: 'Convite inválido. Cole o link completo que a pessoa enviou.',
  not_found: 'Essa pessoa não existe nesta instância.',
  no_keys: 'O contato ainda não publicou chaves. Tente mais tarde.',
  instance_full: 'Esta instância atingiu o limite de pessoas.',
  rate_limited: 'Muitas tentativas seguidas. Aguarde um minuto.',
};

const describe = (e: unknown) => {
  if (e instanceof TypeError) return 'Não foi possível falar com a instância. Verifique a conexão com o Tor e tente de novo.';
  const code = e instanceof Error ? e.message : String(e);
  return ERRORS[code] ?? (e instanceof KeyMismatchError ? ERRORS.identity_mismatch : `Erro: ${code}`);
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

  if (error) return <Welcome><p className="notice danger">{error}</p></Welcome>;
  if (!deps || hasIdentity === null) return <Welcome><p className="muted">Carregando a criptografia…</p></Welcome>;
  if (!messenger) {
    return (
      <Welcome>
        <Gate isNew={!hasIdentity} deps={deps} onReady={setMessenger} />
      </Welcome>
    );
  }
  const lock = () => {
    messenger.close();
    setMessenger(null);
    setHasIdentity(true);
  };
  return <Chat m={messenger} pendingInvite={pendingInvite} clearInvite={() => setPendingInvite(null)} onLock={lock} />;
}

function Welcome({ children }: { children: ReactNode }) {
  return (
    <main className="welcome">
      <div className="welcome-mark">
        <Sigil seed={BRAND_SEED} size={88} brand />
        <h1 className="wordmark">Privatum</h1>
        <p className="tagline">Conversas cifradas no seu navegador. A instância só guarda o que não consegue ler.</p>
      </div>
      {children}
    </main>
  );
}

function Gate({ isNew, deps, onReady }: { isNew: boolean; deps: Deps; onReady: (m: Messenger) => void }) {
  const [pass, setPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [backup, setBackup] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creating = isNew && !restoring;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (restoring && !backup) return setError('Escolha o arquivo de backup.');
    if (creating && pass.length < MIN_PASSPHRASE) return setError(`Use pelo menos ${MIN_PASSPHRASE} caracteres.`);
    if (creating && pass !== confirmPass) return setError('As senhas não coincidem.');
    setBusy(true);
    try {
      onReady(
        restoring
          ? await Messenger.importBackup(await backup!.text(), pass, deps)
          : isNew
            ? await Messenger.create(pass, deps)
            : await Messenger.unlock(pass, deps),
      );
    } catch (err) {
      setError((err as { name?: string } | null)?.name === 'OperationError' ? 'Senha incorreta.' : describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel gate" onSubmit={submit}>
      <h2>{restoring ? 'Restaurar de um backup' : isNew ? 'Criar sua identidade' : 'Desbloquear'}</h2>
      {creating && (
        <p className="muted">
          A senha cifra suas chaves e conversas só neste navegador. Ela nunca vai para a instância e não pode ser recuperada.
        </p>
      )}
      {restoring && (
        <label className="field">
          <span>Arquivo de backup (.privatum)</span>
          <input type="file" accept=".privatum" onChange={(e) => setBackup(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <label className="field">
        <span>Senha local</span>
        <input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
      </label>
      {creating && (
        <label className="field">
          <span>Repita a senha</span>
          <input type="password" autoComplete="new-password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} />
        </label>
      )}
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? 'Derivando a chave…' : restoring ? 'Restaurar' : isNew ? 'Criar identidade' : 'Desbloquear'}
      </button>
      {isNew && (
        <button type="button" className="btn quiet" onClick={() => { setRestoring((v) => !v); setError(''); }}>
          {restoring ? 'Criar uma identidade nova' : 'Tenho um backup'}
        </button>
      )}
      {creating && <p className="hint">O Tor Browser apaga os dados ao fechar. Antes de sair, use “Exportar backup”.</p>}
    </form>
  );
}

interface Confirmation {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

async function downloadBackup(m: Messenger) {
  const url = URL.createObjectURL(new Blob([await m.exportBackup()], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `privatum-backup-${new Date().toISOString().slice(0, 10)}.privatum`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Chat({ m, pendingInvite, clearInvite, onLock }: { m: Messenger; pendingInvite: string | null; clearInvite: () => void; onLock: () => void }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'invite' | 'add' | null>(pendingInvite ? 'add' : null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useEffect(() => m.subscribe(rerender), [m]);
  // Tor Browser wipes site data on close: warn before leaving with unsaved messages.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (m.unsaved > 0) e.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [m]);

  const contact = selected ? m.contact(selected) : undefined;
  const contacts = [...m.contacts].sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  const lock = () =>
    m.unsaved === 0
      ? onLock()
      : setConfirmation({
          title: 'Sair sem backup?',
          body: `${m.unsaved === 1 ? 'Uma mensagem ainda não está' : `${m.unsaved} mensagens ainda não estão`} no backup. Se o Tor Browser for fechado, elas se perdem.`,
          action: 'Sair mesmo assim',
          run: onLock,
        });

  return (
    <div className="app" data-view={contact ? 'conversation' : 'list'}>
      <aside className="sidebar">
        <header className="side-head">
          <div className="me">
            <Sigil seed={m.mailbox} size={36} />
            <span className="me-name">Privatum</span>
          </div>
          <div className="toolbar">
            <button className="icon-btn" title="Meu convite" aria-label="Meu convite" onClick={() => setDialog('invite')}>
              <Icon name="link" />
            </button>
            <button className="icon-btn" title="Exportar backup" aria-label="Exportar backup" onClick={() => downloadBackup(m)}>
              <Icon name="download" />
            </button>
            <button className="icon-btn" title="Sair" aria-label="Sair" onClick={lock}>
              <Icon name="lock" />
            </button>
          </div>
        </header>

        {m.unsaved > 0 && (
          <button className="backup-alert" onClick={() => downloadBackup(m)}>
            <strong>{m.unsaved === 1 ? '1 mensagem fora do backup' : `${m.unsaved} mensagens fora do backup`}</strong>
            <span>Exporte antes de fechar o Tor Browser.</span>
          </button>
        )}

        <button className="btn primary new-chat" onClick={() => setDialog('add')}>
          <Icon name="plus" /> Nova conversa
        </button>

        {contacts.length === 0 ? (
          <p className="muted side-empty">Nenhuma conversa ainda. Envie seu convite ou cole o convite de alguém.</p>
        ) : (
          <ul className="contacts">
            {contacts.map((c) => (
              <li key={c.mailbox}>
                <ContactRow c={c} active={c.mailbox === selected} onOpen={() => setSelected(c.mailbox)} />
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="conversation">
        {contact ? (
          <Conversation key={contact.mailbox} m={m} c={contact} onBack={() => setSelected(null)} onConfirm={setConfirmation} />
        ) : (
          <div className="conv-empty">
            <Sigil seed={m.mailbox} size={72} />
            <p>Escolha uma conversa ou comece uma nova.</p>
            <button className="btn quiet" onClick={() => setDialog('invite')}>Mostrar meu convite</button>
          </div>
        )}
      </section>

      <Modal open={dialog === 'invite'} onClose={() => setDialog(null)} title="Meu convite">
        <MyInvite mailbox={m.mailbox} />
      </Modal>
      <Modal open={dialog === 'add'} onClose={() => setDialog(null)} title="Nova conversa">
        <AddContact
          m={m}
          initial={pendingInvite}
          onAdded={(mb) => {
            clearInvite();
            setDialog(null);
            setSelected(mb);
          }}
        />
      </Modal>
      <Modal open={confirmation !== null} onClose={() => setConfirmation(null)} title={confirmation?.title ?? ''}>
        <p className="muted">{confirmation?.body}</p>
        <div className="modal-actions">
          <button className="btn quiet" onClick={() => setConfirmation(null)}>Cancelar</button>
          <button
            className={confirmation?.danger ? 'btn danger' : 'btn primary'}
            onClick={async () => {
              const run = confirmation?.run;
              setConfirmation(null);
              await run?.();
            }}
          >
            {confirmation?.action}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ContactRow({ c, active, onOpen }: { c: Contact; active: boolean; onOpen: () => void }) {
  const last = c.messages.at(-1);
  return (
    <button className={active ? 'contact active' : 'contact'} onClick={onOpen} aria-current={active || undefined}>
      <Sigil seed={c.mailbox} size={40} />
      <span className="contact-text">
        <span className="contact-top">
          <span className="contact-name">{c.name}</span>
          {last && <time>{time(last.at)}</time>}
        </span>
        <span className="contact-preview">
          {!c.verified && !c.addedByMe ? <span className="tag warn">não verificado</span> : c.verified && <span className="tag ok">verificado</span>}
          <span className="preview-text">{last ? `${last.out ? 'Você: ' : ''}${last.text}` : 'Sem mensagens'}</span>
        </span>
      </span>
    </button>
  );
}

function MyInvite({ mailbox }: { mailbox: string }) {
  const link = inviteLink(location.origin, mailbox);
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <p className="muted">
        Envie este link por um canal em que você confia. Ele leva o endereço desta instância e a impressão digital da sua chave: quem
        abrir consegue falar só com você.
      </p>
      <code className="invite-link">{link}</code>
      <button
        className="btn primary"
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
        }}
      >
        {copied ? 'Copiado' : 'Copiar convite'}
      </button>
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
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Convite</span>
        <input placeholder="Cole aqui o link que a pessoa enviou" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field">
        <span>Nome do contato</span>
        <input placeholder="Só aparece neste aparelho" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !text}>{busy ? 'Conferindo as chaves…' : 'Começar conversa'}</button>
    </form>
  );
}

function closeMenu(e: { currentTarget: Element }) {
  const menu = e.currentTarget.closest('details');
  if (menu) menu.open = false;
}

function Conversation({ m, c, onBack, onConfirm }: { m: Messenger; c: Contact; onBack: () => void; onConfirm: (x: Confirmation) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    safetyCode(m.mailbox, c.mailbox).then(setCode);
  }, [m, c.mailbox]);
  // Braces matter: newer browsers return a Promise from scrollIntoView, which
  // React would then try to call as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [c.messages.length]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    setError('');
    const t = text;
    setText('');
    try {
      await m.send(c.mailbox, t);
    } catch (err) {
      setError(describe(err));
    }
  }

  const trust = c.verified ? 'ok' : c.addedByMe ? 'neutral' : 'warn';
  return (
    <>
      <header className="conv-head">
        <button className="icon-btn back" aria-label="Voltar para as conversas" onClick={onBack}>
          <Icon name="back" />
        </button>
        <Sigil seed={c.mailbox} size={40} />
        <div className="conv-title">
          <h2>{c.name}</h2>
          <button className={`trust ${trust}`} onClick={() => setShowCode(true)}>
            <Icon name="shield" />
            {c.verified ? 'Código conferido' : 'Conferir código de segurança'}
          </button>
        </div>
        <details className="menu">
          <summary className="icon-btn" aria-label="Mais ações">
            <Icon name="more" />
          </summary>
          <div className="menu-list">
            <button
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: 'Apagar conversa?',
                  body: `O histórico com ${c.name} será apagado deste aparelho e não poderá ser recuperado. Se a pessoa escrever de novo, a conversa reaparece.`,
                  action: 'Apagar conversa',
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.deleteContact(c.mailbox);
                  },
                });
              }}
            >
              Apagar conversa
            </button>
            <button
              className="danger"
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: `Bloquear ${c.name}?`,
                  body: 'A conversa será apagada e tudo o que essa pessoa enviar será descartado sem ser lido. Para desbloquear, adicione o convite dela de novo.',
                  action: 'Bloquear',
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.blockContact(c.mailbox);
                  },
                });
              }}
            >
              Bloquear
            </button>
          </div>
        </details>
      </header>

      {!c.addedByMe && !c.verified && (
        <p className="banner">
          Esta pessoa escreveu sem que você tivesse aberto o convite dela.{' '}
          <button className="link" onClick={() => setShowCode(true)}>Confira o código de segurança</button> antes de confiar.
        </p>
      )}

      <div className="messages" role="log" aria-live="polite">
        {c.messages.length === 0 && (
          <p className="muted messages-empty">Nenhuma mensagem ainda. Tudo o que você escrever é cifrado antes de sair deste navegador.</p>
        )}
        {c.messages.map((msg, i) => (
          <div key={i} className={msg.out ? 'bubble out' : 'bubble in'}>
            <p>{msg.text}</p>
            <time>{time(msg.at)}{msg.failed ? ' · não enviada' : ''}</time>
          </div>
        ))}
        <div ref={end} />
      </div>

      {error && <p className="notice danger composer-error" role="alert">{error}</p>}
      <form className="composer" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={Math.min(6, text.split('\n').length)}
          placeholder="Mensagem"
          maxLength={4000}
          aria-label="Mensagem"
        />
        <button className="send" aria-label="Enviar" disabled={!text.trim()}>
          <Icon name="send" />
        </button>
      </form>

      <Modal open={showCode} onClose={() => setShowCode(false)} title="Código de segurança">
        <div className="stack">
          <div className="seal">
            <Sigil seed={m.mailbox} size={44} />
            <Sigil seed={c.mailbox} size={44} />
          </div>
          <p className="muted">
            Compare estes números com {c.name} por voz ou pessoalmente. Se forem iguais nos dois aparelhos, ninguém se colocou no meio da
            conversa.
          </p>
          <div className="code">
            {code.split(' ').map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={c.verified} onChange={(e) => m.setVerified(c.mailbox, e.target.checked)} />
            Os números são iguais nos dois aparelhos
          </label>
        </div>
      </Modal>
    </>
  );
}
