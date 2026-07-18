enum RuntimeState {
    Ready,
    Missing,
}

fn describe(runtime_state: RuntimeState) -> &'static str {
    match runtime_state {
        RuntimeState::Ready => "ready",
        RuntimeState::Missing => "missing",
    }
}
