use std::future::Future;

async fn launch_with<Launch, LaunchFuture>(launch: Launch)
where
    Launch: FnOnce() -> LaunchFuture,
    LaunchFuture: Future<Output = anyhow::Result<()>>,
{
    launch().await.unwrap();
}
