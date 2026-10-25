import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { inviteLink, parseInvite, parseRegistrationCode, safetyCode } from './core/identity.ts';
import {
  AVATAR_COUNT,
  GROUP_PREFIX,
  KeyMismatchError,
  MAX_GROUP,
  MAX_GROUP_NAME,
  MAX_NAME,
  Messenger,
  contactName,
  defaultName,
  type Contact,
  type Deps,
  type Group,
  type Message,
} from './core/messenger.ts';
import { loadOlm, storage } from './platform.ts';
import { AVATAR_NAMES, Avatar, GroupAvatar, Icon, Logo, Modal, Sigil } from './ui.tsx';

const MIN_PASSPHRASE = 12;

const ERRORS: Record<string, string> = {
  bad_backup: 'Este arquivo não é um backup do Privatum.',
  wrong_passphrase: 'Senha incorreta.',
  identity_mismatch: 'As chaves entregues pela instância não correspondem ao convite. Conversa bloqueada por segurança.',
  bad_key_signature: 'A chave do contato tem assinatura inválida. Conversa bloqueada por segurança.',
  bad_invite: 'Convite inválido. Cole o link completo que a pessoa enviou.',
  not_found: 'Essa pessoa não existe nesta instância.',
  no_keys: 'O contato ainda não publicou chaves. Tente mais tarde.',
  instance_full: 'Esta instância atingiu o limite de pessoas.',
  rate_limited: 'Muitas tentativas seguidas. Aguarde um minuto.',
  invite_required: 'Esta instância só aceita pessoas convidadas. Abra o link de convite completo que você recebeu.',
  invalid_invite: 'Este convite já foi usado ou expirou. Peça um convite novo a quem te chamou.',
  registration_closed: 'Esta instância não está aceitando pessoas novas.',
  bad_group_name: 'Dê um nome ao grupo.',
  bad_group_members: `Escolha de 1 a ${MAX_GROUP - 1} contatos.`,
  not_owner: 'Só quem criou o grupo muda os membros.',
};

const describe = (e: unknown) => {
  // fetch() rejects with a TypeError on network failure; other TypeErrors are bugs and must show as-is.
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    return 'Não foi possível falar com a instância. Verifique a conexão com o Tor e tente de novo.';
  }
  const code = e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);
  return ERRORS[code] ?? (e instanceof KeyMismatchError ? ERRORS.identity_mismatch : `Erro: ${code}`);
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function App() {
  const [deps, setDeps] = useState<Deps | null>(null);
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null);
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  // Read the invite once, then drop it from the address bar.
  const [pendingInvite, setPendingInvite] = useState(() => parseInvite(location.hash));
  const [registrationCode] = useState(() => parseRegistrationCode(location.hash) ?? undefined);
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
        <Gate isNew={!hasIdentity} deps={deps} invite={registrationCode} onReady={setMessenger} />
      </Welcome>
    );
  }
  const lock = () => {
    messenger.close();
    setMessenger(null);
    setHasIdentity(true);
  };
  const logout = async () => {
    await messenger.logout();
    setMessenger(null);
    setHasIdentity(false);
  };
  return (
    <Chat m={messenger} pendingInvite={pendingInvite} clearInvite={() => setPendingInvite(null)} onLock={lock} onLogout={logout} />
  );
}

function Welcome({ children }: { children: ReactNode }) {
  return (
    <main className="welcome">
      <div className="welcome-mark">
        <h1 className="brandmark">
          <Logo size={96} />
          <span className="wordmark">Privatum</span>
        </h1>
        <p className="tagline">Conversas cifradas no seu navegador. A instância só guarda o que não consegue ler.</p>
      </div>
      {children}
    </main>
  );
}

function Gate({ isNew, deps, invite, onReady }: { isNew: boolean; deps: Deps; invite?: string; onReady: (m: Messenger) => void }) {
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
          ? await Messenger.importBackup(await backup!.text(), pass, deps, invite)
          : isNew
            ? await Messenger.create(pass, deps, invite)
            : await Messenger.unlock(pass, deps),
      );
    } catch (err) {
      setError(describe(err));
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
  /** Optional extra action that keeps the dialog open (e.g. export a backup first). */
  extra?: { label: string; run: () => void | Promise<void> };
}

// Short two-note chime built with Web Audio (no audio file to download over Tor).
// Browsers only allow sound after a user gesture, so the context is created on the first gesture.
// Every gesture retries until the context runs: on touch screens only the release
// (pointerup/touchend) counts as a gesture, so a single pointerdown is not enough.
let audio: AudioContext | null = null;
const GESTURES = ['pointerup', 'touchend', 'keydown', 'click'] as const;
const unlockAudio = () => {
  try {
    audio ??= new AudioContext();
    void audio.resume().then(() => {
      if (audio?.state === 'running') GESTURES.forEach((e) => removeEventListener(e, unlockAudio));
    });
  } catch {
    // no Web Audio in this browser: stay silent
  }
};
// Listening from page load lets the click on "Desbloquear" itself unlock the sound.
GESTURES.forEach((e) => addEventListener(e, unlockAudio));
function chime() {
  if (!audio) return;
  if (audio.state !== 'running') {
    void audio.resume().then(() => audio?.state === 'running' && chime());
    return;
  }
  const t = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25);
    osc.connect(gain).connect(audio!.destination);
    osc.start(t + i * 0.12);
    osc.stop(t + i * 0.12 + 0.3);
  });
}

// Visual preference only (THREAT-MODEL R9 allows non-secret preferences in localStorage).
const readMuted = () => {
  try {
    return localStorage.getItem('privatum-muted') === '1';
  } catch {
    return false;
  }
};

async function downloadBackup(m: Messenger) {
  const url = URL.createObjectURL(new Blob([await m.exportBackup()], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `privatum-backup-${new Date().toISOString().slice(0, 10)}.privatum`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Chat({
  m,
  pendingInvite,
  clearInvite,
  onLock,
  onLogout,
}: {
  m: Messenger;
  pendingInvite: string | null;
  clearInvite: () => void;
  onLock: () => void;
  onLogout: () => Promise<void>;
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'invite' | 'add' | 'avatar' | 'name' | 'group' | null>(pendingInvite ? 'add' : null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [muted, setMuted] = useState(readMuted);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const selectedRef = useRef(selected);
  const mutedRef = useRef(muted);
  selectedRef.current = selected;
  mutedRef.current = muted;
  useEffect(() => m.subscribe(rerender), [m]);
  useEffect(() => {
    return m.onIncoming((mailbox) => {
      if (!mutedRef.current) chime();
      if (!document.hidden && mailbox === selectedRef.current) return;
      setUnread((u) => ({ ...u, [mailbox]: (u[mailbox] ?? 0) + 1 }));
    });
  }, [m]);
  // Reading a conversation (and coming back to the tab) clears its counter.
  useEffect(() => {
    const clear = () => {
      if (!document.hidden && selectedRef.current) setUnread((u) => ({ ...u, [selectedRef.current!]: 0 }));
    };
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [selected]);
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Privatum` : 'Privatum';
  }, [totalUnread]);
  const toggleMuted = () => {
    setMuted((v) => {
      try {
        localStorage.setItem('privatum-muted', v ? '0' : '1');
      } catch {
        // storage unavailable: the choice lasts for this session only
      }
      return !v;
    });
  };
  // Tor Browser wipes site data on close: warn before leaving with unsaved messages.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (m.unsaved > 0) e.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [m]);

  // `selected` is a thread key: a contact's mailbox, or GROUP_PREFIX + group id.
  const group = selected?.startsWith(GROUP_PREFIX) ? m.group(selected.slice(GROUP_PREFIX.length)) : undefined;
  const contact = selected && !group ? m.contact(selected) : undefined;
  const threads = [
    ...m.contacts.map((c) => ({ key: c.mailbox, last: c.messages.at(-1)?.at ?? 0, c })),
    ...m.groups.map((g) => ({ key: GROUP_PREFIX + g.id, last: g.messages.at(-1)?.at ?? 0, g })),
  ].sort((a, b) => b.last - a.last);
  const logout = () =>
    setConfirmation({
      title: 'Sair deste navegador?',
      body:
        'Sua identidade, contatos e conversas serão apagados deste navegador. Para voltar, você vai precisar do arquivo de backup e da senha local.' +
        (m.unsaved > 0 ? ` Há ${m.unsaved === 1 ? '1 mensagem' : `${m.unsaved} mensagens`} fora do backup.` : ''),
      action: 'Sair e apagar',
      danger: true,
      run: onLogout,
      extra: { label: 'Exportar backup', run: () => downloadBackup(m) },
    });

  return (
    <div className="app" data-view={contact || group ? 'conversation' : 'list'}>
      <aside className="sidebar">
        <header className="side-head">
          <div className="me">
            <Logo size={28} />
            <span className="me-name">Privatum</span>
          </div>
          <div className="toolbar">
            <button className="icon-btn" title="Meu convite" aria-label="Meu convite" onClick={() => setDialog('invite')}>
              <Icon name="link" />
            </button>
            <button className="icon-btn" title="Exportar backup" aria-label="Exportar backup" onClick={() => downloadBackup(m)}>
              <Icon name="download" />
            </button>
            <button className="icon-btn" title="Trancar (pede a senha de novo)" aria-label="Trancar" onClick={onLock}>
              <Icon name="lock" />
            </button>
            <button className="icon-btn" title="Sair (apaga deste navegador)" aria-label="Sair" onClick={logout}>
              <Icon name="logout" />
            </button>
          </div>
        </header>

        <div className="me-row">
          <button className="me-avatar" onClick={() => setDialog('avatar')} title="Escolher meu avatar">
            <Avatar avatar={m.avatar} seed={m.mailbox} size={36} />
            <span>Meu avatar</span>
          </button>
          <button className="me-avatar me-name" onClick={() => setDialog('name')} title="Escolher o nome que seus contatos veem">
            <span>{m.nick ?? 'Meu nome'}</span>
          </button>
          <button className="icon-btn" onClick={toggleMuted} title={muted ? 'Ativar som' : 'Silenciar'} aria-label={muted ? 'Ativar som' : 'Silenciar'} aria-pressed={!muted}>
            <Icon name={muted ? 'muted' : 'sound'} />
          </button>
        </div>

        {m.unsaved > 0 && (
          <button className="backup-alert" onClick={() => downloadBackup(m)}>
            <strong>{m.unsaved === 1 ? '1 mensagem fora do backup' : `${m.unsaved} mensagens fora do backup`}</strong>
            <span>Exporte antes de fechar o Tor Browser.</span>
          </button>
        )}

        <div className="new-row">
          <button className="btn primary new-chat" onClick={() => setDialog('add')}>
            <Icon name="plus" /> Nova conversa
          </button>
          <button className="btn quiet" onClick={() => setDialog('group')} disabled={m.contacts.length === 0} title="Novo grupo">
            <Icon name="group" /> Grupo
          </button>
        </div>

        {threads.length === 0 ? (
          <p className="muted side-empty">Nenhuma conversa ainda. Envie seu convite ou cole o convite de alguém.</p>
        ) : (
          <ul className="contacts">
            {threads.map((t) => {
              const rowUnread = t.key === selected ? 0 : unread[t.key] ?? 0;
              return (
                <li key={t.key}>
                  {'c' in t ? (
                    <ContactRow c={t.c} unread={rowUnread} active={t.key === selected} onOpen={() => setSelected(t.key)} />
                  ) : (
                    <GroupRow m={m} g={t.g} unread={rowUnread} active={t.key === selected} onOpen={() => setSelected(t.key)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="conversation">
        {contact ? (
          <Conversation key={contact.mailbox} m={m} c={contact} onBack={() => setSelected(null)} onConfirm={setConfirmation} />
        ) : group ? (
          <GroupConversation key={group.id} m={m} g={group} onBack={() => setSelected(null)} onConfirm={setConfirmation} />
        ) : (
          <div className="conv-empty">
            <Logo size={96} />
            <p>Escolha uma conversa ou comece uma nova.</p>
            <button className="btn primary" onClick={() => setDialog('invite')}>
              <Icon name="link" /> Mostrar meu convite
            </button>
          </div>
        )}
      </section>

      <Modal open={dialog === 'avatar'} onClose={() => setDialog(null)} title="Meu avatar">
        <p className="muted">Escolha como você aparece para os seus contatos. O avatar vai cifrado dentro das mensagens; a instância não sabe qual é.</p>
        <div className="avatar-grid">
          {Array.from({ length: AVATAR_COUNT }, (_, i) => (
            <button
              key={i}
              className={m.avatar === i ? 'avatar-choice active' : 'avatar-choice'}
              aria-label={AVATAR_NAMES[i]}
              title={AVATAR_NAMES[i]}
              aria-pressed={m.avatar === i}
              onClick={() => {
                void m.setAvatar(i);
                setDialog(null);
              }}
            >
              <Avatar avatar={i} seed={m.mailbox} size={48} />
            </button>
          ))}
        </div>
        <button
          className="btn quiet"
          onClick={() => {
            void m.setAvatar(null);
            setDialog(null);
          }}
        >
          Usar o padrão (anéis)
        </button>
      </Modal>
      <Modal open={dialog === 'name'} onClose={() => setDialog(null)} title="Meu nome">
        <MyName m={m} onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={dialog === 'invite'} onClose={() => setDialog(null)} title="Meu convite">
        {/* Mounted only while open: each opening mints a new code on invite-only instances. */}
        {dialog === 'invite' && <MyInvite m={m} />}
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
      <Modal open={dialog === 'group'} onClose={() => setDialog(null)} title="Novo grupo">
        {dialog === 'group' && (
          <GroupForm
            m={m}
            onSave={async (name, members) => {
              const g = await m.createGroup(name, members);
              setDialog(null);
              setSelected(GROUP_PREFIX + g.id);
            }}
          />
        )}
      </Modal>
      <Modal open={confirmation !== null} onClose={() => setConfirmation(null)} title={confirmation?.title ?? ''}>
        <p className="muted">{confirmation?.body}</p>
        <div className="modal-actions">
          {confirmation?.extra && (
            <button className="btn quiet" onClick={() => confirmation.extra?.run()}>
              {confirmation.extra.label}
            </button>
          )}
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

function ContactRow({ c, active, unread, onOpen }: { c: Contact; active: boolean; unread: number; onOpen: () => void }) {
  const last = c.messages.at(-1);
  return (
    <button className={active ? 'contact active' : 'contact'} onClick={onOpen} aria-current={active || undefined}>
      <Avatar avatar={c.avatar} seed={c.mailbox} size={40} />
      <span className="contact-text">
        <span className="contact-top">
          <span className="contact-name">{contactName(c)}</span>
          {last && <time>{time(last.at)}</time>}
          {unread > 0 && <span className="unread" aria-label={`${unread} novas`}>{unread}</span>}
        </span>
        <span className="contact-preview">
          {!c.verified && !c.addedByMe ? <span className="tag warn">não verificado</span> : c.verified && <span className="tag ok">verificado</span>}
          <span className="preview-text">{last ? (last.deleted ? 'Mensagem apagada' : `${last.out ? 'Você: ' : ''}${last.text}`) : 'Sem mensagens'}</span>
        </span>
      </span>
    </button>
  );
}

/** Who wrote a message in a group: our name for them, the name they chose, or the default. */
function memberName(m: Messenger, mailbox: string) {
  if (mailbox === m.mailbox) return 'Você';
  const c = m.contact(mailbox);
  return c ? contactName(c) : defaultName(mailbox);
}

function GroupRow({ m, g, active, unread, onOpen }: { m: Messenger; g: Group; active: boolean; unread: number; onOpen: () => void }) {
  const last = g.messages.at(-1);
  const who = last && (last.out ? 'Você' : memberName(m, last.from ?? ''));
  return (
    <button className={active ? 'contact active' : 'contact'} onClick={onOpen} aria-current={active || undefined}>
      <GroupAvatar size={40} />
      <span className="contact-text">
        <span className="contact-top">
          <span className="contact-name">{g.name}</span>
          {last && <time>{time(last.at)}</time>}
          {unread > 0 && <span className="unread" aria-label={`${unread} novas`}>{unread}</span>}
        </span>
        <span className="contact-preview">
          {g.left && <span className="tag warn">fora do grupo</span>}
          <span className="preview-text">{last ? (last.deleted ? 'Mensagem apagada' : `${who}: ${last.text}`) : `${g.members.length} pessoas`}</span>
        </span>
      </span>
    </button>
  );
}

/** Creates a group, or (owner) edits its members. Members can be contacts or people already in it. */
function GroupForm({ m, group, onSave }: { m: Messenger; group?: Group; onSave: (name: string, members: string[]) => Promise<void> }) {
  const [name, setName] = useState(group?.name ?? '');
  const [picked, setPicked] = useState<string[]>(group ? group.members.filter((mb) => mb !== m.mailbox) : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidates = [...new Set([...(group?.members ?? []), ...m.contacts.map((c) => c.mailbox)])].filter((mb) => mb !== m.mailbox);
  const toggle = (mb: string) => setPicked((p) => (p.includes(mb) ? p.filter((x) => x !== mb) : [...p, mb]));
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
          await onSave(name, picked);
        } catch (err) {
          setError(describe(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!group && (
        <label className="field">
          <span>Nome do grupo</span>
          <input value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} data-autofocus />
        </label>
      )}
      <fieldset className="pick">
        <legend>Membros ({picked.length + 1} de até {MAX_GROUP}, contando você)</legend>
        {candidates.map((mb) => (
          <label key={mb} className="check">
            <input type="checkbox" checked={picked.includes(mb)} onChange={() => toggle(mb)} />
            {memberName(m, mb)}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        Cada mensagem é cifrada separadamente para cada membro. Os membros veem a lista do grupo, mesmo quem não é contato entre si; a instância não
        sabe que o grupo existe.
      </p>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? 'Avisando os membros…' : group ? 'Salvar membros' : 'Criar grupo'}</button>
    </form>
  );
}

function MyInvite({ m }: { m: Messenger }) {
  // On an invite-only instance each opening mints a fresh single-use code for one person.
  const [registration, setRegistration] = useState<string | null>(null);
  const [link, setLink] = useState(inviteLink(location.origin, m.mailbox));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    m.relay
      .registration()
      .then(async (mode) => {
        if (mode === 'invite') setLink(inviteLink(location.origin, m.mailbox, await m.relay.mintInvite()));
        setRegistration(mode);
      })
      .catch(() => setRegistration('open'));
  }, [m]);
  if (registration === null) return <p className="muted">Preparando o convite…</p>;
  return (
    <div className="stack">
      <p className="muted">
        Envie este link por um canal em que você confia. Ele leva o endereço desta instância e a impressão digital da sua chave: quem
        abrir consegue falar só com você.
      </p>
      {registration === 'invite' && (
        <p className="notice warn">Esta instância só aceita convidados: este link serve para <strong>uma pessoa</strong> e vale 7 dias. Para convidar outra, feche e abra este convite de novo.</p>
      )}
      {registration === 'closed' && (
        <p className="notice warn">A instância não aceita pessoas novas no momento: o link só funciona para quem já participa dela.</p>
      )}
      <code className="invite-link">{link}</code>
      <p className="hint">
        Quem receber deve <strong>segurar a mensagem e escolher “Copiar”</strong>, e colar no Tor Browser. “Copiar link” no WhatsApp e
        em outros apps troca <code>http</code> por <code>https</code>, e o endereço deixa de abrir.
      </p>
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

function MyName({ m, onDone }: { m: Messenger; onDone: () => void }) {
  const [name, setName] = useState(m.nick ?? '');
  const save = (value: string) => {
    void m.setNick(value);
    onDone();
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save(name);
      }}
    >
      <p className="muted">O nome que seus contatos veem. Vai cifrado dentro das mensagens; a instância não sabe qual é. Se um contato já deu outro nome a você, o dele prevalece no aparelho dele.</p>
      <label className="field">
        <span>Nome</span>
        <input value={name} maxLength={MAX_NAME} placeholder="Ex.: Ana" onChange={(e) => setName(e.target.value)} data-autofocus />
      </label>
      <button className="btn primary">Salvar</button>
      {m.nick && (
        <button type="button" className="btn quiet" onClick={() => save('')}>
          Remover nome
        </button>
      )}
    </form>
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
      await m.addContact(mailbox, name.trim() || defaultName(mailbox));
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
        <input placeholder="Opcional; sem nome, aparece o que a pessoa escolheu" value={name} onChange={(e) => setName(e.target.value)} />
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
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    safetyCode(m.mailbox, c.mailbox).then(setCode);
  }, [m, c.mailbox]);

  const trust = c.verified ? 'ok' : c.addedByMe ? 'neutral' : 'warn';
  return (
    <>
      <header className="conv-head">
        <button className="icon-btn back" aria-label="Fechar conversa" title="Fechar conversa" onClick={onBack}>
          <Icon name="back" />
        </button>
        <Avatar avatar={c.avatar} seed={c.mailbox} size={40} />
        <div className="conv-title">
          <h2>{contactName(c)}</h2>
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
                  body: `O histórico com ${contactName(c)} será apagado deste aparelho e não poderá ser recuperado. Se a pessoa escrever de novo, a conversa reaparece.`,
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
                  title: `Bloquear ${contactName(c)}?`,
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

      <Thread m={m} threadKey={c.mailbox} messages={c.messages} others="no aparelho do contato" onConfirm={onConfirm} />

      <Modal open={showCode} onClose={() => setShowCode(false)} title="Código de segurança">
        <div className="stack">
          <div className="seal">
            <Sigil seed={m.mailbox} size={44} />
            <Sigil seed={c.mailbox} size={44} />
          </div>
          <p className="muted">
            Compare estes números com {contactName(c)} por voz ou pessoalmente. Se forem iguais nos dois aparelhos, ninguém se colocou no meio da
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

function GroupConversation({ m, g, onBack, onConfirm }: { m: Messenger; g: Group; onBack: () => void; onConfirm: (x: Confirmation) => void }) {
  const [showMembers, setShowMembers] = useState(false);
  const [editing, setEditing] = useState(false);
  const owner = g.owner === m.mailbox && !g.left;
  return (
    <>
      <header className="conv-head">
        <button className="icon-btn back" aria-label="Fechar conversa" title="Fechar conversa" onClick={onBack}>
          <Icon name="back" />
        </button>
        <GroupAvatar size={40} />
        <div className="conv-title">
          <h2>{g.name}</h2>
          <button className="trust neutral" onClick={() => setShowMembers(true)}>
            <Icon name="group" />
            {g.members.length} {g.members.length === 1 ? 'pessoa' : 'pessoas'}
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
                setShowMembers(true);
              }}
            >
              Membros
            </button>
            {!g.left && (
              <button
                onClick={(e) => {
                  closeMenu(e);
                  onConfirm({
                    title: `Sair de ${g.name}?`,
                    body: 'Os membros são avisados e você para de receber as mensagens do grupo. O histórico fica neste aparelho. Para voltar, quem criou o grupo precisa adicionar você de novo.',
                    action: 'Sair do grupo',
                    danger: true,
                    run: () => m.leaveGroup(g.id),
                  });
                }}
              >
                Sair do grupo
              </button>
            )}
            <button
              className="danger"
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: 'Apagar o grupo deste aparelho?',
                  body: g.left
                    ? 'O histórico do grupo será apagado deste aparelho e não poderá ser recuperado.'
                    : 'Você sai do grupo (os membros são avisados) e o histórico é apagado deste aparelho.',
                  action: 'Apagar grupo',
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.deleteGroup(g.id);
                  },
                });
              }}
            >
              Apagar grupo
            </button>
          </div>
        </details>
      </header>

      {g.left && <p className="banner">Você não faz mais parte deste grupo. O histórico fica só para leitura.</p>}

      <Thread
        m={m}
        threadKey={GROUP_PREFIX + g.id}
        messages={g.messages}
        readOnly={g.left}
        senderName={(mb) => memberName(m, mb)}
        others="nos aparelhos dos membros"
        onConfirm={onConfirm}
      />

      <Modal
        open={showMembers}
        onClose={() => {
          setShowMembers(false);
          setEditing(false);
        }}
        title={editing ? 'Editar membros' : 'Membros'}
      >
        {editing ? (
          <GroupForm
            m={m}
            group={g}
            onSave={async (_, members) => {
              await m.setGroupMembers(g.id, members);
              setEditing(false);
            }}
          />
        ) : (
          <div className="stack">
            <ul className="member-list">
              {g.members.map((mb) => (
                <li key={mb}>
                  <span>{memberName(m, mb)}</span>
                  {mb === g.owner && <span className="tag ok">criou o grupo</span>}
                  {mb !== m.mailbox && !m.contacts.some((c) => c.mailbox === mb) && <span className="tag warn">não é seu contato</span>}
                </li>
              ))}
            </ul>
            <p className="hint">
              Só quem criou o grupo muda os membros. Quem não é seu contato aparece pelo nome que escolheu; para conferir a identidade, adicione o
              convite da pessoa e compare o código de segurança.
            </p>
            {owner && (
              <button className="btn primary" onClick={() => setEditing(true)}>
                Editar membros
              </button>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

/** Messages and composer, shared by one-to-one and group conversations. */
function Thread({
  m,
  threadKey,
  messages,
  readOnly,
  senderName,
  others,
  onConfirm,
}: {
  m: Messenger;
  threadKey: string;
  messages: Message[];
  readOnly?: boolean;
  /** Groups: label incoming messages with their sender. */
  senderName?: (mailbox: string) => string;
  /** Where "delete for everyone" also deletes, for the confirmation text. */
  others: string;
  onConfirm: (x: Confirmation) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // Braces matter: newer browsers return a Promise from scrollIntoView, which
  // React would then try to call as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    setError('');
    const t = text;
    const target = editing;
    setText('');
    setEditing(null);
    try {
      if (target?.id) await m.editMessage(threadKey, target.id, t);
      else await m.send(threadKey, t);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="muted messages-empty">Nenhuma mensagem ainda. Tudo o que você escrever é cifrado antes de sair deste navegador.</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.out ? 'msg out' : 'msg in'}>
            <button
              className={msg.out ? 'bubble out' : 'bubble in'}
              aria-expanded={actionsFor === msg}
              onClick={() => setActionsFor(actionsFor === msg ? null : msg)}
            >
              {senderName && !msg.out && msg.from && <span className="sender">{senderName(msg.from)}</span>}
              {msg.deleted ? <span className="bubble-text deleted">Mensagem apagada</span> : <span className="bubble-text">{msg.text}</span>}
              <time>
                {time(msg.at)}
                {msg.edited && !msg.deleted ? ' · editada' : ''}
                {msg.failed ? (senderName ? ' · não chegou a todos' : ' · não enviada') : ''}
              </time>
            </button>
            {actionsFor === msg && (
              <div className="msg-actions">
                {msg.out && msg.id && !msg.deleted && !readOnly && (
                  <button
                    onClick={() => {
                      setEditing(msg);
                      setText(msg.text);
                      setActionsFor(null);
                    }}
                  >
                    Editar
                  </button>
                )}
                {msg.out && msg.id && !msg.deleted && !readOnly && (
                  <button
                    className="danger"
                    onClick={() => {
                      setActionsFor(null);
                      onConfirm({
                        title: 'Apagar para todos?',
                        body: `A mensagem será apagada aqui e ${others}. Não há como garantir que ninguém a viu, fez captura de tela ou tem um backup anterior.`,
                        action: 'Apagar para todos',
                        danger: true,
                        run: () => m.deleteMessage(threadKey, msg, true).catch((err) => setError(describe(err))),
                      });
                    }}
                  >
                    Apagar para todos
                  </button>
                )}
                <button
                  onClick={() => {
                    setActionsFor(null);
                    onConfirm({
                      title: 'Apagar para mim?',
                      body: 'A mensagem some só deste aparelho. Os outros continuam com ela.',
                      action: 'Apagar para mim',
                      danger: true,
                      run: () => m.deleteMessage(threadKey, msg, false),
                    });
                  }}
                >
                  Apagar para mim
                </button>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>

      {error && <p className="notice danger composer-error" role="alert">{error}</p>}
      {editing && (
        <div className="editing-bar">
          <span>Editando mensagem</span>
          <button
            className="link"
            onClick={() => {
              setEditing(null);
              setText('');
            }}
          >
            Cancelar
          </button>
        </div>
      )}
      {!readOnly && (
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
      )}
    </>
  );
}
