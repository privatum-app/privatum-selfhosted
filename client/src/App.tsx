import { Fragment, useEffect, useReducer, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { inviteLink, parseInvite, safetyCode } from './core/identity.ts';
import {
  AVATAR_COUNT,
  GROUP_PREFIX,
  KeyMismatchError,
  MAX_GROUP,
  MAX_GROUP_NAME,
  MAX_NAME,
  Messenger,
  REACTIONS,
  TIMERS,
  contactName,
  defaultName,
  sameText,
  type Contact,
  type Deps,
  type Group,
  type Message,
} from './core/messenger.ts';
import { loadOlm, storage } from './platform.ts';
import { lang, locale, setLang, t } from './i18n.ts';
import { AVATAR_NAMES, Avatar, GroupAvatar, Icon, Logo, Modal, Qr, Sigil } from './ui.tsx';

const MIN_PASSPHRASE = 12;

const ERRORS: Record<string, string> = {
  bad_backup: t('Este arquivo não é um backup do Privatum.'),
  wrong_passphrase: t('Senha incorreta.'),
  identity_mismatch: t('As chaves entregues pela instância não correspondem ao convite. Conversa bloqueada por segurança.'),
  bad_key_signature: t('A chave do contato tem assinatura inválida. Conversa bloqueada por segurança.'),
  bad_invite: t('Convite inválido. Cole o link completo que a pessoa enviou.'),
  not_found: t('Essa pessoa não existe nesta instância.'),
  no_keys: t('O contato ainda não publicou chaves. Tente mais tarde.'),
  instance_full: t('Esta instância atingiu o limite de pessoas.'),
  rate_limited: t('Muitas tentativas seguidas. Aguarde um minuto.'),
  bad_group_name: t('Dê um nome ao grupo.'),
  bad_group_members: t('Escolha de 1 a {n} contatos.', { n: MAX_GROUP - 1 }),
  not_owner: t('Só quem criou o grupo muda isso.'),
};

const describe = (e: unknown) => {
  // fetch() rejects with a TypeError on network failure; other TypeErrors are bugs and must show as-is.
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    return t('Não foi possível falar com a instância. Verifique a conexão com o Tor e tente de novo.');
  }
  const code = e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);
  return ERRORS[code] ?? (e instanceof KeyMismatchError ? ERRORS.identity_mismatch : t('Erro: {code}', { code }));
};

const dayKey = (at: number) => new Date(at).toDateString();

/** "Hoje", "Ontem", or the date (with the year only when it is not this year). */
function dayLabel(at: number) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('Hoje');
  if (d.toDateString() === yesterday.toDateString()) return t('Ontem');
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

const time = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

const TIMER_LABELS: Record<number, string> = { 0: 'Desligadas', 3600: '1 hora', 86_400: '1 dia', 604_800: '7 dias' };

/** One line for a timer notice, e.g. "Você ativou as mensagens temporárias (1 dia)". */
const timerNotice = (who: string, timer: number) =>
  timer
    ? t('{who} ativou as mensagens temporárias ({time})', { who, time: t(TIMER_LABELS[timer]) })
    : t('{who} desligou as mensagens temporárias', { who });

/** Sidebar preview of a thread's last message. */
function preview(last: Message | undefined, who: string, empty: string) {
  if (!last) return empty;
  if (last.info) return timerNotice(who, last.info.timer);
  if (last.deleted) return t('Mensagem apagada');
  return who ? `${who}: ${last.text}` : last.text;
}

export function App() {
  const [deps, setDeps] = useState<Deps | null>(null);
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null);
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  // Read the invite once, then drop it from the address bar.
  const [pendingInvite, setPendingInvite] = useState(() => parseInvite(location.hash));
  const [wasmFailed, setWasmFailed] = useState(false);
  const [tutorial, setTutorial] = useState(false);

  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname);
    loadOlm()
      .then(async (olm) => {
        setDeps({ olm, storage, base: location.origin, host: location.host });
        setHasIdentity(await Messenger.exists(storage));
      })
      .catch(() => setWasmFailed(true));
  }, []);

  if (wasmFailed) return <Welcome><SaferHelp /></Welcome>;
  if (!deps || hasIdentity === null) return <Welcome><p className="muted">{t('Carregando a criptografia…')}</p></Welcome>;
  if (!messenger) {
    return (
      <Welcome>
        <Gate
          isNew={!hasIdentity}
          deps={deps}
          onReady={(m, created) => {
            setTutorial(created);
            setMessenger(m);
          }}
        />
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
    <Chat
      m={messenger}
      pendingInvite={pendingInvite}
      clearInvite={() => setPendingInvite(null)}
      onLock={lock}
      onLogout={logout}
      tutorial={tutorial}
      onTutorialDone={() => setTutorial(false)}
    />
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
        <p className="tagline">{t('Conversas cifradas no seu navegador. A instância só guarda o que não consegue ler.')}</p>
        <LangSwitch />
      </div>
      {children}
    </main>
  );
}

/**
 * The client needs WebAssembly, which Tor Browser turns off at the "Safer" and "Safest"
 * levels. Say exactly how to get back to "Standard" instead of just failing.
 */
function SaferHelp() {
  return (
    <div className="panel gate">
      <h2>{t('Ajuste o nível de segurança do Tor Browser')}</h2>
      <p className="muted">
        {typeof WebAssembly === 'undefined'
          ? t('Este navegador está com o WebAssembly desligado. No Tor Browser isso acontece nos níveis "Mais seguro" (Safer) e "O mais seguro" (Safest).')
          : t('Não foi possível carregar a criptografia (WebAssembly).')}{' '}
        O Privatum cifra tudo no seu navegador e precisa dele.
      </p>
      <ol className="steps">
        <li>{t('Toque no ícone do')}{' '}<strong>{t('escudo')}</strong>{t(', ao lado da barra de endereço (no Android: menu ⋮ → Configurações → Privacidade e segurança).')}</li>
        <li>{t('Abra')}{' '}<strong>{t('Configurações de segurança')}</strong>{' '}{t('e escolha')}{' '}<strong>{t('Padrão')}</strong>{' '}{t('(Standard).')}</li>
        <li>{t('Recarregue esta página.')}</li>
      </ol>
      <p className="hint">
        {t('O nível Padrão vale para todos os sites que você abrir. Se preferir, volte ao nível anterior quando terminar de usar o Privatum.')}
      </p>
      <button className="btn primary" onClick={() => location.reload()}>{t('Recarregar')}</button>
    </div>
  );
}

function Tutorial({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={t('Como o Privatum funciona')}>
      <div className="stack">
        <ol className="steps">
          <li>
            <strong>{t('Sua identidade mora neste navegador.')}</strong>{' '}{t('As chaves e conversas ficam cifradas aqui com a sua senha local. A instância só repassa mensagens que não consegue ler.')}
          </li>
          <li>
            <strong>{t('Convide pelo “Meu convite”')}</strong>{' '}{t('(ícone de link, no topo). Mande o link por um canal em que você confia.')}
          </li>
          <li>
            <strong>{t('Confira o código de segurança')}</strong>{' '}{t('de cada contato por voz ou pessoalmente. Se for igual nos dois aparelhos, ninguém está no meio.')}
          </li>
          <li>
            <strong>{t('Exporte o backup.')}</strong>{' '}{t('O Tor Browser apaga os dados ao fechar. Sem o arquivo de backup e a senha, a identidade se perde.')}
          </li>
        </ol>
        <button className="btn primary" onClick={onClose}>{t('Entendi')}</button>
        <LangSwitch />
      </div>
    </Modal>
  );
}

function Gate({ isNew, deps, onReady }: { isNew: boolean; deps: Deps; onReady: (m: Messenger, created: boolean) => void }) {
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
    if (restoring && !backup) return setError(t('Escolha o arquivo de backup.'));
    if (creating && pass.length < MIN_PASSPHRASE) return setError(t('Use pelo menos {n} caracteres.', { n: MIN_PASSPHRASE }));
    if (creating && pass !== confirmPass) return setError(t('As senhas não coincidem.'));
    setBusy(true);
    try {
      onReady(
        restoring
          ? await Messenger.importBackup(await backup!.text(), pass, deps)
          : isNew
            ? await Messenger.create(pass, deps)
            : await Messenger.unlock(pass, deps),
        creating,
      );
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel gate" onSubmit={submit}>
      <h2>{restoring ? t('Restaurar de um backup') : isNew ? t('Criar sua identidade') : t('Desbloquear')}</h2>
      {creating && (
        <p className="muted">
          {t('A senha cifra suas chaves e conversas só neste navegador. Ela nunca vai para a instância e não pode ser recuperada.')}
        </p>
      )}
      {restoring && (
        <label className="field">
          <span>{t('Arquivo de backup (.privatum)')}</span>
          <input type="file" accept=".privatum" onChange={(e) => setBackup(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <label className="field">
        <span>{t('Senha local')}</span>
        <input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
      </label>
      {creating && (
        <label className="field">
          <span>{t('Repita a senha')}</span>
          <input type="password" autoComplete="new-password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} />
        </label>
      )}
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? t('Derivando a chave…') : restoring ? t('Restaurar') : isNew ? t('Criar identidade') : t('Desbloquear')}
      </button>
      {isNew && (
        <button type="button" className="btn quiet" onClick={() => { setRestoring((v) => !v); setError(''); }}>
          {restoring ? t('Criar uma identidade nova') : t('Tenho um backup')}
        </button>
      )}
      {creating && <p className="hint">{t('O Tor Browser apaga os dados ao fechar. Antes de sair, use “Exportar backup”.')}</p>}
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
  tutorial,
  onTutorialDone,
}: {
  m: Messenger;
  pendingInvite: string | null;
  clearInvite: () => void;
  onLock: () => void;
  onLogout: () => Promise<void>;
  tutorial: boolean;
  onTutorialDone: () => void;
}) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'invite' | 'add' | 'avatar' | 'name' | 'group' | null>(pendingInvite ? 'add' : null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [muted, setMuted] = useState(readMuted);
  const [unread, setUnread] = useState<Record<string, number>>({});
  // Unread count when the open conversation was opened, for its "new messages" divider.
  const [openedUnread, setOpenedUnread] = useState(0);
  const [help, setHelp] = useState(false);
  const open = (key: string) => {
    setOpenedUnread(key === selected ? 0 : unread[key] ?? 0);
    setSelected(key);
  };
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
      title: t('Sair deste navegador?'),
      body:
        t('Sua identidade, contatos e conversas serão apagados deste navegador. Para voltar, você vai precisar do arquivo de backup e da senha local.') +
        (m.unsaved > 0 ? ' ' + (m.unsaved === 1 ? t('Há 1 mensagem fora do backup.') : t('Há {n} mensagens fora do backup.', { n: m.unsaved })) : ''),
      action: t('Sair e apagar'),
      danger: true,
      run: onLogout,
      extra: { label: t('Exportar backup'), run: () => downloadBackup(m) },
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
            <button className="icon-btn" title={t('Como funciona')} aria-label={t('Como funciona')} onClick={() => setHelp(true)}>
              <Icon name="help" />
            </button>
            <button className="icon-btn" title={t('Meu convite')} aria-label={t('Meu convite')} onClick={() => setDialog('invite')}>
              <Icon name="link" />
            </button>
            <button className="icon-btn" title={t('Exportar backup')} aria-label={t('Exportar backup')} onClick={() => downloadBackup(m)}>
              <Icon name="download" />
            </button>
            <button className="icon-btn" title={t('Trancar (pede a senha de novo)')} aria-label={t('Trancar')} onClick={onLock}>
              <Icon name="lock" />
            </button>
            <button className="icon-btn" title={t('Sair (apaga deste navegador)')} aria-label={t('Sair')} onClick={logout}>
              <Icon name="logout" />
            </button>
          </div>
        </header>

        <div className="me-row">
          <button className="me-avatar" onClick={() => setDialog('avatar')} title={t('Escolher meu avatar')}>
            <Avatar avatar={m.avatar} size={36} />
            <span>{t('Meu avatar')}</span>
          </button>
          <button className="me-avatar me-name" onClick={() => setDialog('name')} title={t('Escolher o nome que seus contatos veem')}>
            <span>{m.nick ?? t('Meu nome')}</span>
          </button>
          <button className="icon-btn" onClick={toggleMuted} title={muted ? t('Ativar som') : t('Silenciar')} aria-label={muted ? t('Ativar som') : t('Silenciar')} aria-pressed={!muted}>
            <Icon name={muted ? 'muted' : 'sound'} />
          </button>
        </div>

        {m.unsaved > 0 && (
          <button className="backup-alert" onClick={() => downloadBackup(m)}>
            <strong>{m.unsaved === 1 ? t('1 mensagem fora do backup') : t('{n} mensagens fora do backup', { n: m.unsaved })}</strong>
            <span>{t('Exporte antes de fechar o Tor Browser.')}</span>
          </button>
        )}
        {m.recreated && (
          <button className="backup-alert" onClick={() => { m.recreated = false; rerender(); }} title={t('Fechar aviso')}>
            <strong>{t('O dono da instância removeu sua conta')}</strong>
            <span>{t('Ela foi recriada e você continua com a mesma identidade e os mesmos contatos. Mensagens que esperavam entrega se perderam. Toque para fechar.')}</span>
          </button>
        )}

        <div className="new-row">
          <button className="btn primary new-chat" onClick={() => setDialog('add')}>
            <Icon name="plus" />{' '}{t('Nova conversa')}
          </button>
          <button className="btn quiet" onClick={() => setDialog('group')} disabled={m.contacts.length === 0} title={t('Novo grupo')}>
            <Icon name="group" />{' '}{t('Grupo')}
          </button>
        </div>

        {threads.length === 0 ? (
          <p className="muted side-empty">{t('Nenhuma conversa ainda. Envie seu convite ou cole o convite de alguém.')}</p>
        ) : (
          <ul className="contacts">
            {threads.map((t) => {
              const rowUnread = t.key === selected ? 0 : unread[t.key] ?? 0;
              return (
                <li key={t.key}>
                  {'c' in t ? (
                    <ContactRow c={t.c} alike={!!m.lookalike(t.c.mailbox)} unread={rowUnread} active={t.key === selected} onOpen={() => open(t.key)} />
                  ) : (
                    <GroupRow m={m} g={t.g} unread={rowUnread} active={t.key === selected} onOpen={() => open(t.key)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="conversation">
        {contact ? (
          <Conversation key={contact.mailbox} m={m} c={contact} newCount={openedUnread} onBack={() => setSelected(null)} onConfirm={setConfirmation} />
        ) : group ? (
          <GroupConversation key={group.id} m={m} g={group} newCount={openedUnread} onBack={() => setSelected(null)} onConfirm={setConfirmation} />
        ) : (
          <div className="conv-empty">
            <Logo size={96} />
            <p>{t('Escolha uma conversa ou comece uma nova.')}</p>
            <button className="btn primary" onClick={() => setDialog('invite')}>
              <Icon name="link" />{' '}{t('Mostrar meu convite')}
            </button>
          </div>
        )}
      </section>

      <Modal open={dialog === 'avatar'} onClose={() => setDialog(null)} title={t('Meu avatar')}>
        <p className="muted">{t('Escolha como você aparece para os seus contatos. O avatar vai cifrado dentro das mensagens; a instância não sabe qual é.')}</p>
        <div className="avatar-grid">
          {Array.from({ length: AVATAR_COUNT }, (_, i) => (
            <button
              key={i}
              className={m.avatar === i ? 'avatar-choice active' : 'avatar-choice'}
              aria-label={t(AVATAR_NAMES[i])}
              title={t(AVATAR_NAMES[i])}
              aria-pressed={m.avatar === i}
              onClick={() => {
                void m.setAvatar(i);
                setDialog(null);
              }}
            >
              <Avatar avatar={i} size={48} />
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
          {t('Usar o padrão (cebola)')}
        </button>
      </Modal>
      <Modal open={dialog === 'name'} onClose={() => setDialog(null)} title={t('Meu nome')}>
        <MyName m={m} onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={dialog === 'invite'} onClose={() => setDialog(null)} title={t('Meu convite')}>
        {dialog === 'invite' && <MyInvite m={m} />}
      </Modal>
      <Modal open={dialog === 'add'} onClose={() => setDialog(null)} title={t('Nova conversa')}>
        <AddContact
          m={m}
          initial={pendingInvite}
          onAdded={(mb) => {
            clearInvite();
            setDialog(null);
            open(mb);
          }}
        />
      </Modal>
      <Tutorial
        open={tutorial || help}
        onClose={() => {
          setHelp(false);
          onTutorialDone();
        }}
      />
      <Modal open={dialog === 'group'} onClose={() => setDialog(null)} title={t('Novo grupo')}>
        {dialog === 'group' && (
          <GroupForm
            m={m}
            onSave={async (name, members) => {
              const g = await m.createGroup(name, members);
              setDialog(null);
              open(GROUP_PREFIX + g.id);
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
          <button className="btn quiet" onClick={() => setConfirmation(null)}>{t('Cancelar')}</button>
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

function ContactRow({ c, alike, active, unread, onOpen }: { c: Contact; alike: boolean; active: boolean; unread: number; onOpen: () => void }) {
  const last = c.messages.at(-1);
  return (
    <button className={active ? 'contact active' : 'contact'} onClick={onOpen} aria-current={active || undefined}>
      <Avatar avatar={c.avatar} size={40} />
      <span className="contact-text">
        <span className="contact-top">
          <span className="contact-name">{displayName(c)}</span>
          {last && <time>{time(last.at)}</time>}
          {unread > 0 && <span className="unread" aria-label={t('{n} novas', { n: unread })}>{unread}</span>}
        </span>
        <span className="contact-preview">
          {alike ? (
            <span className="tag danger">{t('nome repetido')}</span>
          ) : !c.verified && !c.addedByMe ? (
            <span className="tag warn">{t('não verificado')}</span>
          ) : (
            c.verified && <span className="tag ok">{t('verificado')}</span>
          )}
          <span className="preview-text">{preview(last, last?.out ? t('Você') : last?.info ? displayName(c) : '', t('Sem mensagens'))}</span>
        </span>
      </span>
    </button>
  );
}

/** A contact's name for display: the stored default ("Contato abc123") follows the interface language. */
function displayName(c: Contact) {
  const name = contactName(c);
  return name === defaultName(c.mailbox) ? t('Contato {id}', { id: c.mailbox.slice(0, 6) }) : name;
}

/** Who wrote a message in a group: our name for them, the name they chose, or the default. */
function memberName(m: Messenger, mailbox: string) {
  if (mailbox === m.mailbox) return t('Você');
  const c = m.contact(mailbox);
  return c ? displayName(c) : t('Contato {id}', { id: mailbox.slice(0, 6) });
}

/** Switches the interface language (Portuguese or English); the page reloads. */
function LangSwitch() {
  return (
    <button className="btn quiet lang-switch" onClick={() => setLang(lang() === 'en' ? 'pt' : 'en')}>
      {lang() === 'en' ? 'Português' : 'English'}
    </button>
  );
}

function GroupRow({ m, g, active, unread, onOpen }: { m: Messenger; g: Group; active: boolean; unread: number; onOpen: () => void }) {
  const last = g.messages.at(-1);
  const who = last && (last.out ? t('Você') : memberName(m, last.from ?? ''));
  return (
    <button className={active ? 'contact active' : 'contact'} onClick={onOpen} aria-current={active || undefined}>
      <GroupAvatar size={40} />
      <span className="contact-text">
        <span className="contact-top">
          <span className="contact-name">{g.name}</span>
          {last && <time>{time(last.at)}</time>}
          {unread > 0 && <span className="unread" aria-label={t('{n} novas', { n: unread })}>{unread}</span>}
        </span>
        <span className="contact-preview">
          {g.left && <span className="tag warn">{g.ended ? t('encerrado') : t('fora do grupo')}</span>}
          <span className="preview-text">{preview(last, who ?? '', t('{n} pessoas', { n: g.members.length }))}</span>
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
          <span>{t('Nome do grupo')}</span>
          <input value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} data-autofocus />
        </label>
      )}
      <fieldset className="pick">
        <legend>{t('Membros ({n} de até {max}, contando você)', { n: picked.length + 1, max: MAX_GROUP })}</legend>
        {candidates.map((mb) => (
          <label key={mb} className="check">
            <input type="checkbox" checked={picked.includes(mb)} onChange={() => toggle(mb)} />
            {memberName(m, mb)}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        {t('Cada mensagem é cifrada separadamente para cada membro. Os membros veem a lista do grupo, mesmo quem não é contato entre si; a instância não sabe que o grupo existe.')}
      </p>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? t('Avisando os membros…') : group ? t('Salvar membros') : t('Criar grupo')}</button>
    </form>
  );
}

function TimerTag({ timer }: { timer?: number }) {
  if (!timer) return null;
  return (
    <span className="timer-tag" title={t('Mensagens temporárias: {time}', { time: t(TIMER_LABELS[timer]) })}>
      <Icon name="timer" /> {t(TIMER_LABELS[timer])}
    </span>
  );
}

function TimerDialog({ m, threadKey, timer, open, onClose }: { m: Messenger; threadKey: string; timer?: number; open: boolean; onClose: () => void }) {
  const [error, setError] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={t('Mensagens temporárias')}>
      <div className="stack">
        <p className="muted">
          {t('As mensagens novas somem dos aparelhos de todos depois do prazo. Não impede captura de tela nem cópias em backups feitos antes. A cópia cifrada que ainda não foi entregue fica na instância até ser entregue (no máximo 14 dias).')}
        </p>
        <div className="modes">
          {TIMERS.map((secs) => (
            <label key={secs} className={`mode ${(timer ?? 0) === secs ? 'active' : ''}`}>
              <input
                type="radio"
                name="timer"
                value={secs}
                checked={(timer ?? 0) === secs}
                onChange={() =>
                  m.setTimer(threadKey, secs).then(
                    () => {
                      setError('');
                      onClose();
                    },
                    (e) => setError(describe(e)),
                  )
                }
              />
              <span>{t(TIMER_LABELS[secs])}</span>
            </label>
          ))}
        </div>
        {error && <p className="notice danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function MyInvite({ m }: { m: Messenger }) {
  const link = inviteLink(location.origin, m.mailbox);
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <p className="muted">
        {t('Envie este link por um canal em que você confia. Ele leva o endereço desta instância e a impressão digital da sua chave: quem abrir consegue falar só com você.')}
      </p>
      <code className="invite-link">{link}</code>
      <Qr text={link} />
      <p className="hint">
        {t('Pessoalmente, a outra pessoa pode ler o QR code. Se a câmera abrir outro navegador, copie o link e cole no Tor Browser: endereços .onion só abrem nele.')}
      </p>
      <p className="hint">
        {t('Quem receber deve')}{' '}<strong>{t('segurar a mensagem e escolher “Copiar”')}</strong>{t(', e colar no Tor Browser. “Copiar link” no WhatsApp e em outros apps troca')}{' '}<code>http</code>{' '}{t('por')}{' '}<code>https</code>{t(', e o endereço deixa de abrir.')}
      </p>
      <button
        className="btn primary"
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
        }}
      >
        {copied ? t('Copiado') : t('Copiar convite')}
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
      <p className="muted">{t('O nome que seus contatos veem. Vai cifrado dentro das mensagens; a instância não sabe qual é. Se um contato já deu outro nome a você, o dele prevalece no aparelho dele.')}</p>
      <label className="field">
        <span>{t('Nome')}</span>
        <input value={name} maxLength={MAX_NAME} placeholder={t('Ex.: Ana')} onChange={(e) => setName(e.target.value)} data-autofocus />
      </label>
      <button className="btn primary">{t('Salvar')}</button>
      {m.nick && (
        <button type="button" className="btn quiet" onClick={() => save('')}>
          {t('Remover nome')}
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
        <span>{t('Convite')}</span>
        <input placeholder={t('Cole aqui o link que a pessoa enviou')} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('Nome do contato')}</span>
        <input placeholder={t('Opcional; sem nome, aparece o que a pessoa escolheu')} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !text}>{busy ? t('Conferindo as chaves…') : t('Começar conversa')}</button>
    </form>
  );
}

function closeMenu(e: { currentTarget: Element }) {
  const menu = e.currentTarget.closest('details');
  if (menu) menu.open = false;
}

function Conversation({
  m,
  c,
  newCount,
  onBack,
  onConfirm,
}: {
  m: Messenger;
  c: Contact;
  newCount: number;
  onBack: () => void;
  onConfirm: (x: Confirmation) => void;
}) {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [showTimer, setShowTimer] = useState(false);
  const [searching, setSearching] = useState(false);
  const alike = m.lookalike(c.mailbox);

  useEffect(() => {
    safetyCode(m.mailbox, c.mailbox).then(setCode);
  }, [m, c.mailbox]);

  const trust = c.verified ? 'ok' : c.addedByMe ? 'neutral' : 'warn';
  return (
    <>
      <header className="conv-head">
        <button className="icon-btn back" aria-label={t('Fechar conversa')} title={t('Fechar conversa')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <Avatar avatar={c.avatar} size={40} />
        <div className="conv-title">
          <h2>
            {displayName(c)}
            <TimerTag timer={c.timer} />
          </h2>
          <button className={`trust ${trust}`} onClick={() => setShowCode(true)}>
            <Icon name="shield" />
            {c.verified ? t('Código conferido') : t('Conferir código de segurança')}
          </button>
        </div>
        <button className="icon-btn" title={t('Buscar na conversa')} aria-label={t('Buscar na conversa')} onClick={() => setSearching((v) => !v)}>
          <Icon name="search" />
        </button>
        <details className="menu">
          <summary className="icon-btn" aria-label={t('Mais ações')}>
            <Icon name="more" />
          </summary>
          <div className="menu-list">
            <button
              onClick={(e) => {
                closeMenu(e);
                setShowTimer(true);
              }}
            >
              {t('Mensagens temporárias')}
            </button>
            <button
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: t('Apagar conversa?'),
                  body: t('O histórico com {name} será apagado deste aparelho e não poderá ser recuperado. Se a pessoa escrever de novo, a conversa reaparece.', { name: displayName(c) }),
                  action: t('Apagar conversa'),
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.deleteContact(c.mailbox);
                  },
                });
              }}
            >
              {t('Apagar conversa')}
            </button>
            <button
              className="danger"
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: t('Bloquear {name}?', { name: displayName(c) }),
                  body: t('A conversa será apagada e tudo o que essa pessoa enviar será descartado sem ser lido. Para desbloquear, adicione o convite dela de novo.'),
                  action: t('Bloquear'),
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.blockContact(c.mailbox);
                  },
                });
              }}
            >
              {t('Bloquear')}
            </button>
          </div>
        </details>
      </header>

      {alike ? (
        <p className="banner danger">
          {t('Atenção: “{name}” já está nos seus contatos com outra identidade. Pode ser alguém se passando por essa pessoa, ou ela criou uma identidade nova.', { name: displayName(alike) })}{' '}
          <button className="link" onClick={() => setShowCode(true)}>{t('Confira o código de segurança')}</button>{' '}{t('com ela por outro meio antes de confiar.')}
        </p>
      ) : !c.addedByMe && !c.verified && (
        <p className="banner">
          {t('Esta pessoa escreveu sem que você tivesse aberto o convite dela.')}{' '}
          <button className="link" onClick={() => setShowCode(true)}>{t('Confira o código de segurança')}</button>{' '}{t('antes de confiar.')}
        </p>
      )}

      <Thread
        m={m}
        threadKey={c.mailbox}
        messages={c.messages}
        nameOf={(mb) => (mb === m.mailbox ? t('Você') : displayName(c))}
        others={t('no aparelho do contato')}
        onConfirm={onConfirm}
        searching={searching}
        onCloseSearch={() => setSearching(false)}
        newCount={newCount}
      />
      <TimerDialog m={m} threadKey={c.mailbox} timer={c.timer} open={showTimer} onClose={() => setShowTimer(false)} />

      <Modal open={showCode} onClose={() => setShowCode(false)} title={t('Código de segurança')}>
        <div className="stack">
          <div className="seal">
            <Sigil seed={m.mailbox} size={44} />
            <Sigil seed={c.mailbox} size={44} />
          </div>
          <p className="muted">
            {t('Compare estes números com {name} por voz ou pessoalmente. Se forem iguais nos dois aparelhos, ninguém se colocou no meio da conversa.', { name: displayName(c) })}
          </p>
          <p className="hint">
            {t('Este código não muda: ele vem das chaves de identidade, que ficam fixas para este contato (o app recusa chaves diferentes). Se a pessoa criar uma identidade nova, ela aparece como outro contato, sem verificação.')}
          </p>
          <div className="code">
            {code.split(' ').map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={c.verified} onChange={(e) => m.setVerified(c.mailbox, e.target.checked)} />
            {t('Os números são iguais nos dois aparelhos')}
          </label>
        </div>
      </Modal>
    </>
  );
}

function GroupConversation({
  m,
  g,
  newCount,
  onBack,
  onConfirm,
}: {
  m: Messenger;
  g: Group;
  newCount: number;
  onBack: () => void;
  onConfirm: (x: Confirmation) => void;
}) {
  const [showMembers, setShowMembers] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showTimer, setShowTimer] = useState(false);
  const [searching, setSearching] = useState(false);
  const owner = g.owner === m.mailbox && !g.left;
  return (
    <>
      <header className="conv-head">
        <button className="icon-btn back" aria-label={t('Fechar conversa')} title={t('Fechar conversa')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <GroupAvatar size={40} />
        <div className="conv-title">
          <h2>
            {g.name}
            <TimerTag timer={g.timer} />
          </h2>
          <button className="trust neutral" onClick={() => setShowMembers(true)}>
            <Icon name="group" />
            {g.members.length === 1 ? t('1 pessoa') : t('{n} pessoas', { n: g.members.length })}
          </button>
        </div>
        <button className="icon-btn" title={t('Buscar na conversa')} aria-label={t('Buscar na conversa')} onClick={() => setSearching((v) => !v)}>
          <Icon name="search" />
        </button>
        <details className="menu">
          <summary className="icon-btn" aria-label={t('Mais ações')}>
            <Icon name="more" />
          </summary>
          <div className="menu-list">
            <button
              onClick={(e) => {
                closeMenu(e);
                setShowMembers(true);
              }}
            >
              {t('Membros')}
            </button>
            {owner && (
              <button
                onClick={(e) => {
                  closeMenu(e);
                  setShowTimer(true);
                }}
              >
                {t('Mensagens temporárias')}
              </button>
            )}
            {!g.left && (
              <button
                onClick={(e) => {
                  closeMenu(e);
                  onConfirm(
                    owner
                      ? {
                          title: t('Encerrar {name}?', { name: g.name }),
                          body: t('O grupo termina para todos: os membros são avisados e ninguém mais consegue escrever nele. O histórico fica nos aparelhos, só para leitura. Não dá para reabrir; para conversar de novo, crie outro grupo.'),
                          action: t('Encerrar o grupo'),
                          danger: true,
                          run: () => m.leaveGroup(g.id),
                        }
                      : {
                          title: t('Sair de {name}?', { name: g.name }),
                          body: t('Os membros são avisados e você para de receber as mensagens do grupo. O histórico fica neste aparelho. Para voltar, quem criou o grupo precisa adicionar você de novo.'),
                          action: t('Sair do grupo'),
                          danger: true,
                          run: () => m.leaveGroup(g.id),
                        },
                  );
                }}
              >
                {owner ? t('Encerrar o grupo') : t('Sair do grupo')}
              </button>
            )}
            <button
              className="danger"
              onClick={(e) => {
                closeMenu(e);
                onConfirm({
                  title: t('Apagar o grupo deste aparelho?'),
                  body: g.left
                    ? t('O histórico do grupo será apagado deste aparelho e não poderá ser recuperado.')
                    : owner
                      ? t('O grupo é encerrado para todos os membros (eles são avisados e não conseguem mais escrever nele) e o histórico é apagado deste aparelho.')
                      : t('Você sai do grupo (os membros são avisados) e o histórico é apagado deste aparelho.'),
                  action: t('Apagar grupo'),
                  danger: true,
                  run: async () => {
                    onBack();
                    await m.deleteGroup(g.id);
                  },
                });
              }}
            >
              {t('Apagar grupo')}
            </button>
          </div>
        </details>
      </header>

      {g.left && (
        <p className="banner">
          {g.ended
            ? g.owner === m.mailbox
              ? t('Você encerrou este grupo. O histórico fica só para leitura.')
              : t('Quem criou este grupo o encerrou. O histórico fica só para leitura.')
            : t('Você não faz mais parte deste grupo. O histórico fica só para leitura.')}
        </p>
      )}

      <Thread
        m={m}
        threadKey={GROUP_PREFIX + g.id}
        messages={g.messages}
        readOnly={g.left}
        group
        nameOf={(mb) => memberName(m, mb)}
        others={t('nos aparelhos dos membros')}
        onConfirm={onConfirm}
        searching={searching}
        onCloseSearch={() => setSearching(false)}
        newCount={newCount}
      />
      <TimerDialog m={m} threadKey={GROUP_PREFIX + g.id} timer={g.timer} open={showTimer} onClose={() => setShowTimer(false)} />

      <Modal
        open={showMembers}
        onClose={() => {
          setShowMembers(false);
          setEditing(false);
        }}
        title={editing ? t('Editar membros') : t('Membros')}
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
                  {mb === g.owner && <span className="tag ok">{t('criou o grupo')}</span>}
                  {mb !== m.mailbox && !m.contacts.some((c) => c.mailbox === mb) && <span className="tag warn">{t('não é seu contato')}</span>}
                  {m.lookalike(mb) && <span className="tag danger">{t('nome igual ao de outro contato')}</span>}
                </li>
              ))}
            </ul>
            <p className="hint">
              {t('Só quem criou o grupo muda os membros. Quem não é seu contato aparece pelo nome que escolheu; para conferir a identidade, adicione o convite da pessoa e compare o código de segurança.')}
            </p>
            {owner && (
              <button className="btn primary" onClick={() => setEditing(true)}>
                {t('Editar membros')}
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
  group,
  nameOf,
  others,
  onConfirm,
  searching,
  onCloseSearch,
  newCount,
}: {
  m: Messenger;
  threadKey: string;
  messages: Message[];
  readOnly?: boolean;
  /** Groups label incoming messages with their sender. */
  group?: boolean;
  /** Display name for a mailbox in this thread (us included). */
  nameOf: (mailbox: string) => string;
  /** Where "delete for everyone" also deletes, for the confirmation text. */
  others: string;
  onConfirm: (x: Confirmation) => void;
  searching: boolean;
  onCloseSearch: () => void;
  /** Unread messages when the conversation was opened: a divider marks where they start. */
  newCount: number;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const authorOf = (msg: Message) => (msg.out ? m.mailbox : (msg.from ?? threadKey));
  const [query, setQuery] = useState('');
  const q = searching ? sameText(query) : '';
  const shown = q ? messages.filter((msg) => !msg.info && !msg.deleted && sameText(msg.text).includes(q)) : messages;
  // Index of the first of the last `newCount` incoming messages (no divider while searching).
  let firstNew = -1;
  if (!q && newCount > 0) {
    for (let i = shown.length - 1, seen = 0; i >= 0; i--) {
      if (!shown[i].out && !shown[i].info && ++seen === newCount) {
        firstNew = i;
        break;
      }
    }
  }

  // Braces matter: newer browsers return a Promise from scrollIntoView, which
  // React would then try to call as the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    setError('');
    const t = text;
    const target = editing;
    const answering = replyTo;
    setText('');
    setEditing(null);
    setReplyTo(null);
    try {
      if (target?.id) await m.editMessage(threadKey, target.id, t);
      else await m.send(threadKey, t, answering ?? undefined);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <>
      {searching && (
        <div className="search-bar">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Buscar nesta conversa')}
            aria-label={t('Buscar nesta conversa')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCloseSearch();
            }}
          />
          {q && <span className="muted">{shown.length === 1 ? t('1 mensagem') : t('{n} mensagens', { n: shown.length })}</span>}
          <button
            className="icon-btn"
            aria-label={t('Fechar busca')}
            onClick={() => {
              setQuery('');
              onCloseSearch();
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="muted messages-empty">{t('Nenhuma mensagem ainda. Tudo o que você escrever é cifrado antes de sair deste navegador.')}</p>
        )}
        {q && shown.length === 0 && <p className="muted messages-empty">{t('Nenhuma mensagem com esse texto.')}</p>}
        {shown.map((msg, i) => {
          const prev = shown[i - 1];
          const newDay = !prev || dayKey(prev.at) !== dayKey(msg.at);
          // Same author, same day, under 5 minutes apart: drawn as one block.
          const cont = !newDay && !!prev && !prev.info && !msg.info && authorOf(prev) === authorOf(msg) && msg.at - prev.at < 5 * 60_000 && i !== firstNew;
          const marks = (
            <>
              {newDay && <p className="day-sep">{dayLabel(msg.at)}</p>}
              {i === firstNew && <p className="new-sep">{newCount === 1 ? t('1 mensagem nova') : t('{n} mensagens novas', { n: newCount })}</p>}
            </>
          );
          if (msg.info) {
            return (
              <Fragment key={i}>
                {marks}
                <p className="info-line">
                  <Icon name="timer" /> {timerNotice(nameOf(msg.info.by), msg.info.timer)}
                </p>
              </Fragment>
            );
          }
          const quoted = msg.reply && m.quoted(threadKey, msg);
          const mine = msg.reactions?.[m.mailbox];
          const counts = Object.values(msg.reactions ?? {}).reduce<Record<string, number>>((acc, e) => ({ ...acc, [e]: (acc[e] ?? 0) + 1 }), {});
          return (
          <Fragment key={i}>
          {marks}
          <div className={`msg ${msg.out ? 'out' : 'in'}${cont ? ' cont' : ''}`}>
            <button
              className={msg.out ? 'bubble out' : 'bubble in'}
              aria-expanded={actionsFor === msg}
              onClick={() => setActionsFor(actionsFor === msg ? null : msg)}
            >
              {group && !msg.out && msg.from && !cont && <span className="sender">{nameOf(msg.from)}</span>}
              {msg.reply && (
                <span className="quote">
                  {quoted ? (
                    <>
                      <strong>{nameOf(authorOf(quoted))}</strong>
                      <span>{quoted.deleted ? t('Mensagem apagada') : quoted.text}</span>
                    </>
                  ) : (
                    <span>{t('Mensagem original indisponível')}</span>
                  )}
                </span>
              )}
              {msg.deleted ? <span className="bubble-text deleted">{t('Mensagem apagada')}</span> : <span className="bubble-text">{msg.text}</span>}
              <time>
                {msg.exp && <Icon name="timer" />}
                {time(msg.at)}
                {msg.edited && !msg.deleted ? t(' · editada') : ''}
                {msg.failed ? (group ? t(' · não chegou a todos') : t(' · não enviada')) : ''}
              </time>
            </button>
            {Object.keys(counts).length > 0 && (
              <div className="reactions">
                {Object.entries(counts).map(([e, n]) => (
                  <span key={e} className={mine === e ? 'reaction mine' : 'reaction'}>
                    {e}
                    {n > 1 && <small>{n}</small>}
                  </span>
                ))}
              </div>
            )}
            {actionsFor === msg && (
              <div className="msg-actions">
                {msg.id && !msg.deleted && !readOnly && (
                  <div className="react-picker" role="group" aria-label={t('Reagir')}>
                    {REACTIONS.map((e) => (
                      <button
                        key={e}
                        className={mine === e ? 'mine' : undefined}
                        aria-pressed={mine === e}
                        onClick={() => {
                          setActionsFor(null);
                          m.react(threadKey, msg, mine === e ? null : e).catch((err) => setError(describe(err)));
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                {msg.id && !msg.deleted && !readOnly && (
                  <button
                    onClick={() => {
                      setReplyTo(msg);
                      setEditing(null);
                      setActionsFor(null);
                    }}
                  >
                    {t('Responder')}
                  </button>
                )}
                {msg.out && msg.id && !msg.deleted && !readOnly && (
                  <button
                    onClick={() => {
                      setEditing(msg);
                      setReplyTo(null);
                      setText(msg.text);
                      setActionsFor(null);
                    }}
                  >
                    {t('Editar')}
                  </button>
                )}
                {msg.out && msg.id && !msg.deleted && !readOnly && (
                  <button
                    className="danger"
                    onClick={() => {
                      setActionsFor(null);
                      onConfirm({
                        title: t('Apagar para todos?'),
                        body: t('A mensagem será apagada aqui e {where}. Não há como garantir que ninguém a viu, fez captura de tela ou tem um backup anterior.', { where: others }),
                        action: t('Apagar para todos'),
                        danger: true,
                        run: () => m.deleteMessage(threadKey, msg, true).catch((err) => setError(describe(err))),
                      });
                    }}
                  >
                    {t('Apagar para todos')}
                  </button>
                )}
                <button
                  onClick={() => {
                    setActionsFor(null);
                    onConfirm({
                      title: t('Apagar para mim?'),
                      body: t('A mensagem some só deste aparelho. Os outros continuam com ela.'),
                      action: t('Apagar para mim'),
                      danger: true,
                      run: () => m.deleteMessage(threadKey, msg, false),
                    });
                  }}
                >
                  {t('Apagar para mim')}
                </button>
              </div>
            )}
          </div>
          </Fragment>
          );
        })}
        <div ref={end} />
      </div>

      {error && <p className="notice danger composer-error" role="alert">{error}</p>}
      {replyTo && (
        <div className="editing-bar">
          <span className="reply-preview">
            {t('Respondendo a')}{' '}<strong>{nameOf(authorOf(replyTo))}</strong>: {replyTo.text}
          </span>
          <button className="link" onClick={() => setReplyTo(null)}>
            {t('Cancelar')}
          </button>
        </div>
      )}
      {editing && (
        <div className="editing-bar">
          <span>{t('Editando mensagem')}</span>
          <button
            className="link"
            onClick={() => {
              setEditing(null);
              setText('');
            }}
          >
            {t('Cancelar')}
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
            placeholder={t('Mensagem')}
            maxLength={4000}
            aria-label={t('Mensagem')}
          />
          <button className="send" aria-label={t('Enviar')} disabled={!text.trim()}>
            <Icon name="send" />
          </button>
        </form>
      )}
    </>
  );
}
