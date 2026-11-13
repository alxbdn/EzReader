//! Password protection: AES-256 encryption (PDF 2.0, revision 6) and its removal.

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, Permissions};

use crate::fsutil;

/// Writes `input` to `output` encrypted with `password` (needed to open it).
/// Everything stays allowed once it is open: printing, copying, editing.
#[tauri::command]
pub fn encrypt_pdf(input_path: String, output_path: String, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("The password is empty".into());
    }
    let mut doc = Document::load(&input_path).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        return Err("This PDF is already encrypted".into());
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("No randomness available: {e}"))?;
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let state = EncryptionState::try_from(EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &password,
        user_password: &password,
        permissions: Permissions::all(),
    })
    .map_err(|e| e.to_string())?;
    doc.encrypt(&state).map_err(|e| e.to_string())?;
    fsutil::save_document(&mut doc, &output_path)
}

/// Writes `input` to `output` without its password. Fails with
/// "wrong password" when `password` does not open it.
#[tauri::command]
pub fn decrypt_pdf(input_path: String, output_path: String, password: String) -> Result<(), String> {
    let mut doc = Document::load_with_password(&input_path, &password).map_err(|e| {
        let text = e.to_string();
        if text.to_lowercase().contains("password") || text.to_lowercase().contains("decrypt") {
            "wrong password".to_string()
        } else {
            text
        }
    })?;
    if doc.is_encrypted() {
        // Loaded but still locked: the password did not open it.
        doc.decrypt(&password).map_err(|_| "wrong password".to_string())?;
    }
    doc.trailer.remove(b"Encrypt");
    fsutil::save_document(&mut doc, &output_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{fixture, tmp};

    #[test]
    fn encrypt_then_decrypt_round_trip() {
        let locked = tmp("locked.pdf");
        let open = tmp("unlocked.pdf");
        let pw = "tortue-orange-saute-7-fois-é";
        encrypt_pdf(fixture("objstm-indirect-length.pdf"), locked.clone(), pw.into()).unwrap();

        let raw = Document::load(&locked);
        assert!(raw.is_err() || raw.unwrap().is_encrypted(), "the file needs its password");
        assert!(decrypt_pdf(locked.clone(), open.clone(), "nope".into()).unwrap_err().contains("wrong password"));

        decrypt_pdf(locked.clone(), open.clone(), pw.into()).unwrap();
        let doc = Document::load(&open).unwrap();
        assert!(!doc.is_encrypted());
        assert_eq!(doc.get_pages().len(), 2);
        assert!(doc.extract_text(&[1]).unwrap().contains("Page 1"));

        for p in [locked, open] {
            std::fs::remove_file(p).ok();
        }
    }

    #[test]
    fn empty_password_is_refused() {
        assert!(encrypt_pdf(fixture("objstm-indirect-length.pdf"), tmp("x.pdf"), String::new()).is_err());
    }
}
