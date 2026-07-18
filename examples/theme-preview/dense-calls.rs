use std::path::PathBuf;

fn verify_browser_runtime_with(path: PathBuf) -> bool {
    path.exists()
}

fn dense_call_site(primary: PathBuf, fallback: PathBuf) -> bool {
    // Repetition and punctuation make the callable the intended landmark.
    verify_browser_runtime_with(primary)
        || verify_browser_runtime_with(fallback.clone())
        || verify_browser_runtime_with(fallback)
}
