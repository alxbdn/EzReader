//! The error every command returns to the frontend: a stable `code` the
//! interface translates, and a `detail` in English for the cases it does
//! not know (shown as is, and useful in bug reports).
//!
//! The frontend matches on `code`, never on the text.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// The password does not open the file.
    WrongPassword,
    /// A password was required but none was given.
    EmptyPassword,
    /// The file is already password-protected.
    AlreadyEncrypted,
    /// Another file already has that name.
    Exists,
    /// The file name cannot be used.
    InvalidName,
    /// The user cancelled the operation.
    Cancelled,
    /// The file is not a picture EzReader can read or write.
    NotAnImage,
    /// The file is too large to read.
    TooLarge,
    /// The operation would have changed the number of pages; nothing was written.
    PageCountChanged,
    /// A page number or range does not exist in the document.
    InvalidPages,
    /// Windows has no OCR language for this (or OCR is not available).
    NoOcrLanguage,
    /// The path is not a file the user opened or chose (see `grants`).
    NotAllowed,
    /// Anything else: `detail` says what.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PdfError {
    pub code: ErrorCode,
    pub detail: String,
}

impl PdfError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        PdfError { code, detail: detail.into() }
    }
}

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for PdfError {}

/// Errors that carry no code yet are `Other`, with their text as detail.
impl From<String> for PdfError {
    fn from(detail: String) -> Self {
        PdfError::new(ErrorCode::Other, detail)
    }
}

impl From<&str> for PdfError {
    fn from(detail: &str) -> Self {
        PdfError::new(ErrorCode::Other, detail)
    }
}

impl From<lopdf::Error> for PdfError {
    fn from(e: lopdf::Error) -> Self {
        PdfError::new(ErrorCode::Other, e.to_string())
    }
}

impl From<std::io::Error> for PdfError {
    fn from(e: std::io::Error) -> Self {
        PdfError::new(ErrorCode::Other, e.to_string())
    }
}

/// The result of every command.
pub type CmdResult<T> = Result<T, PdfError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_detail() {
        let e = PdfError::new(ErrorCode::WrongPassword, "wrong password");
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"code":"wrong-password","detail":"wrong password"}"#);
        let other: PdfError = "boom".into();
        assert_eq!(serde_json::to_value(&other).unwrap()["code"], "other");
    }
}
