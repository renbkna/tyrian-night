use std::path::PathBuf;

fn resolve_runtime(runtime_specification: &str) -> PathBuf {
    // The local identifier remains legible without becoming the main landmark.
    let resolved_browser_path = PathBuf::from(runtime_specification);
    resolved_browser_path
}
