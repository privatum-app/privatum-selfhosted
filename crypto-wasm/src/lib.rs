//! Browser bindings for vodozemac's Olm (Double Ratchet). This crate only
//! converts types (base64 strings, byte arrays, JSON); every cryptographic
//! operation is vodozemac's. Errors are plain strings so the same code is
//! testable natively and becomes a JS exception in the browser.

use data_encoding::BASE64_NOPAD;
use vodozemac::{
    olm::{self, OlmMessage, SessionConfig},
    KeyId,
    Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature,
};
use wasm_bindgen::prelude::*;

type Res<T> = Result<T, String>;

// Olm v1 (8-byte truncated MAC) is the audited default used by Matrix; v2 is
// still behind vodozemac's "experimental-session-config" feature, so not used.
const CONFIG: SessionConfig = SessionConfig::version_1();

fn pickle_key(key: &[u8]) -> Res<[u8; 32]> {
    key.try_into().map_err(|_| "pickle key must be 32 bytes".to_owned())
}

fn curve(key: &str) -> Res<Curve25519PublicKey> {
    Curve25519PublicKey::from_base64(key).map_err(|e| e.to_string())
}

fn message(message_type: u32, ciphertext: &str) -> Res<OlmMessage> {
    let bytes = BASE64_NOPAD.decode(ciphertext.as_bytes()).map_err(|e| e.to_string())?;
    OlmMessage::from_parts(message_type as usize, &bytes).map_err(|e| e.to_string())
}

fn keys_json(keys: impl IntoIterator<Item = (KeyId, Curve25519PublicKey)>) -> String {
    let map: serde_json::Map<String, serde_json::Value> =
        keys.into_iter().map(|(id, key)| (id.to_base64(), key.to_base64().into())).collect();
    serde_json::Value::Object(map).to_string()
}

/// Verifies an Ed25519 signature (strict verification, as in vodozemac).
#[wasm_bindgen(js_name = verifyEd25519)]
pub fn verify_ed25519(key: &str, message: &[u8], signature: &str) -> bool {
    let (Ok(key), Ok(sig)) = (Ed25519PublicKey::from_base64(key), Ed25519Signature::from_base64(signature)) else {
        return false;
    };
    key.verify(message, &sig).is_ok()
}

#[wasm_bindgen]
pub struct Account {
    inner: olm::Account,
}

#[wasm_bindgen]
impl Account {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Account {
        Account { inner: olm::Account::new() }
    }

    #[wasm_bindgen(getter)]
    pub fn ed25519(&self) -> String {
        self.inner.ed25519_key().to_base64()
    }

    #[wasm_bindgen(getter)]
    pub fn curve25519(&self) -> String {
        self.inner.curve25519_key().to_base64()
    }

    pub fn sign(&self, message: &[u8]) -> String {
        self.inner.sign(message).to_base64()
    }

    #[wasm_bindgen(js_name = generateOneTimeKeys)]
    pub fn generate_one_time_keys(&mut self, count: usize) {
        self.inner.generate_one_time_keys(count);
    }

    /// Unpublished one-time keys as JSON: `{ "<key_id>": "<curve25519>" }`.
    #[wasm_bindgen(js_name = oneTimeKeys)]
    pub fn one_time_keys(&self) -> String {
        keys_json(self.inner.one_time_keys())
    }

    #[wasm_bindgen(js_name = generateFallbackKey)]
    pub fn generate_fallback_key(&mut self) {
        self.inner.generate_fallback_key();
    }

    /// Unpublished fallback key as JSON (same shape as `oneTimeKeys`).
    #[wasm_bindgen(js_name = fallbackKey)]
    pub fn fallback_key(&self) -> String {
        keys_json(self.inner.fallback_key())
    }

    #[wasm_bindgen(js_name = markKeysAsPublished)]
    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
    }

    /// Starts a session with a peer. The caller must already have checked
    /// the peer's identity (mailbox id) and the one-time key's signature.
    #[wasm_bindgen(js_name = createOutboundSession)]
    pub fn create_outbound_session(&self, identity_key: &str, one_time_key: &str) -> Res<Session> {
        let inner = self
            .inner
            .create_outbound_session(CONFIG, curve(identity_key)?, curve(one_time_key)?)
            .map_err(|e| e.to_string())?;
        Ok(Session { inner })
    }

    /// Accepts the first (pre-key, type 0) message from a peer. Fails if the
    /// message was not created for `their_identity_key`.
    #[wasm_bindgen(js_name = createInboundSession)]
    pub fn create_inbound_session(&mut self, their_identity_key: &str, ciphertext: &str) -> Res<Inbound> {
        let OlmMessage::PreKey(pre_key) = message(0, ciphertext)? else {
            return Err("not a pre-key message".into());
        };
        let result = self
            .inner
            .create_inbound_session(CONFIG, curve(their_identity_key)?, &pre_key)
            .map_err(|e| e.to_string())?;
        Ok(Inbound { session: Some(Session { inner: result.session }), plaintext: result.plaintext })
    }

    pub fn pickle(&self, key: &[u8]) -> Res<String> {
        Ok(self.inner.pickle().encrypt(&pickle_key(key)?))
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Res<Account> {
        let pickle = olm::AccountPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(|e| e.to_string())?;
        Ok(Account { inner: olm::Account::from_pickle(pickle) })
    }
}

#[wasm_bindgen]
pub struct Inbound {
    session: Option<Session>,
    plaintext: Vec<u8>,
}

#[wasm_bindgen]
impl Inbound {
    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }

    /// Hands over the new session; can be called once.
    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(&mut self) -> Res<Session> {
        self.session.take().ok_or_else(|| "session already taken".to_owned())
    }
}

#[wasm_bindgen]
pub struct Encrypted {
    message_type: u32,
    ciphertext: String,
}

#[wasm_bindgen]
impl Encrypted {
    /// 0 = pre-key message (first messages of a session), 1 = normal message.
    #[wasm_bindgen(getter, js_name = messageType)]
    pub fn message_type(&self) -> u32 {
        self.message_type
    }

    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> String {
        self.ciphertext.clone()
    }
}

#[wasm_bindgen]
pub struct Session {
    inner: olm::Session,
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Res<Encrypted> {
        let (message_type, bytes) = self.inner.encrypt(plaintext).map_err(|e| e.to_string())?.to_parts();
        Ok(Encrypted { message_type: message_type as u32, ciphertext: BASE64_NOPAD.encode(&bytes) })
    }

    pub fn decrypt(&mut self, message_type: u32, ciphertext: &str) -> Res<Vec<u8>> {
        self.inner.decrypt(&message(message_type, ciphertext)?).map_err(|e| e.to_string())
    }

    pub fn pickle(&self, key: &[u8]) -> Res<String> {
        Ok(self.inner.pickle().encrypt(&pickle_key(key)?))
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, key: &[u8]) -> Res<Session> {
        let pickle = olm::SessionPickle::from_encrypted(pickle, &pickle_key(key)?).map_err(|e| e.to_string())?;
        Ok(Session { inner: olm::Session::from_pickle(pickle) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_one_time_key(account: &Account) -> String {
        let keys: serde_json::Value = serde_json::from_str(&account.one_time_keys()).unwrap();
        keys.as_object().unwrap().values().next().unwrap().as_str().unwrap().to_owned()
    }

    fn pair() -> (Account, Account, Session, Session) {
        let alice = Account::new();
        let mut bob = Account::new();
        bob.generate_one_time_keys(1);
        let otk = first_one_time_key(&bob);
        bob.mark_keys_as_published();

        let mut to_bob = alice.create_outbound_session(&bob.curve25519(), &otk).unwrap();
        let first = to_bob.encrypt(b"hello bob").unwrap();
        assert_eq!(first.message_type(), 0);
        let mut inbound = bob.create_inbound_session(&alice.curve25519(), &first.ciphertext()).unwrap();
        assert_eq!(inbound.plaintext(), b"hello bob");
        let to_alice = inbound.take_session().unwrap();
        assert!(inbound.take_session().is_err());
        (alice, bob, to_bob, to_alice)
    }

    #[test]
    fn round_trip_both_directions() {
        let (_, _, mut a, mut b) = pair();
        let reply = b.encrypt(b"hi alice").unwrap();
        assert_eq!(reply.message_type(), 1);
        assert_eq!(a.decrypt(1, &reply.ciphertext()).unwrap(), b"hi alice");
        let next = a.encrypt(b"again").unwrap();
        assert_eq!(next.message_type(), 1, "ratchet advanced after the reply");
        assert_eq!(b.decrypt(1, &next.ciphertext()).unwrap(), b"again");
        assert_eq!(a.session_id(), b.session_id());
    }

    #[test]
    fn replayed_message_is_rejected() {
        let (_, _, mut a, mut b) = pair();
        let m = a.encrypt(b"once").unwrap();
        let m = (m.message_type(), m.ciphertext());
        b.decrypt(m.0, &m.1).unwrap();
        assert!(b.decrypt(m.0, &m.1).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let (_, _, _, mut b) = pair();
        let mut a2 = pair().2;
        let m = a2.encrypt(b"not for you").unwrap();
        assert!(b.decrypt(m.message_type(), &m.ciphertext()).is_err());
        assert!(b.decrypt(1, "AAAA").is_err());
    }

    #[test]
    fn inbound_rejects_wrong_sender_identity() {
        let alice = Account::new();
        let mallory = Account::new();
        let mut bob = Account::new();
        bob.generate_one_time_keys(1);
        let otk = first_one_time_key(&bob);
        let m = alice.create_outbound_session(&bob.curve25519(), &otk).unwrap().encrypt(b"x").unwrap();
        assert!(bob.create_inbound_session(&mallory.curve25519(), &m.ciphertext()).is_err());
    }

    #[test]
    fn pickles_round_trip_and_need_the_right_key() {
        let (alice, _, mut a, b) = pair();
        let key = [7u8; 32];
        let restored = Account::from_pickle(&alice.pickle(&key).unwrap(), &key).unwrap();
        assert_eq!(restored.ed25519(), alice.ed25519());
        assert!(Account::from_pickle(&alice.pickle(&key).unwrap(), &[8u8; 32]).is_err());
        assert!(alice.pickle(&[0u8; 31]).is_err());

        let mut b2 = Session::from_pickle(&b.pickle(&key).unwrap(), &key).unwrap();
        let m = a.encrypt(b"after restore").unwrap();
        assert_eq!(b2.decrypt(m.message_type(), &m.ciphertext()).unwrap(), b"after restore");
    }

    #[test]
    fn signatures_verify_only_for_the_signed_message() {
        let a = Account::new();
        let sig = a.sign(b"privatum-otk-v1:key");
        assert!(verify_ed25519(&a.ed25519(), b"privatum-otk-v1:key", &sig));
        assert!(!verify_ed25519(&a.ed25519(), b"other", &sig));
        assert!(!verify_ed25519(&Account::new().ed25519(), b"privatum-otk-v1:key", &sig));
        assert!(!verify_ed25519("garbage", b"x", &sig));
    }

    #[test]
    fn keys_are_unpadded_base64_of_32_bytes() {
        let a = Account::new();
        for k in [a.ed25519(), a.curve25519()] {
            assert_eq!(BASE64_NOPAD.decode(k.as_bytes()).unwrap().len(), 32);
        }
    }
}
