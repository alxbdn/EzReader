import { EpubBook, type Book } from "./epub-book";
import { CbzBook } from "./book-cbz";
import { HtmlBook, TextBook } from "./book-text";

export const BOOK_EXTENSIONS = ["epub", "cbz", "txt", "html", "htm"] as const;

const BOOK = new RegExp(`\\.(${BOOK_EXTENSIONS.join("|")})$`, "i");

export function isBookPath(path: string): boolean {
  return BOOK.test(path);
}

export async function openBook(path: string, bytes: Uint8Array): Promise<Book> {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case "cbz": return CbzBook.open(bytes);
    case "txt": return TextBook.open(bytes);
    case "html":
    case "htm": return HtmlBook.open(bytes);
    default: return EpubBook.open(bytes);
  }
}
