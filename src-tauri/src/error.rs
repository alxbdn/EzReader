use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    WrongPassword,
    EmptyPassword,
    AlreadyEncrypted,
    Exists,
    InvalidName,
    Cancelled,
    NotAnImage,
    TooLarge,
    PageCountChanged,
    InvalidPages,
    NoOcrLanguage,
    NotAllowed,
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
