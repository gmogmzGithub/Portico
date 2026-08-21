use super::*;

#[test]
fn wait_handler_clamps_requested_seconds() {
    assert_eq!(clamped_wait_seconds(&Map::new()), 1);
    assert_eq!(clamped_wait_seconds(&args(&[("seconds", json!(0))])), 1);
    assert_eq!(clamped_wait_seconds(&args(&[("seconds", json!(999))])), 300);
}

#[tokio::test]
async fn wait_handler_sleeps_for_about_one_second() {
    let started = std::time::Instant::now();
    let payload = response_payload(handle_wait(&args(&[("seconds", json!(1))])).await.unwrap());
    let elapsed = started.elapsed();

    assert_eq!(payload["waited_seconds"], json!(1));
    assert!(elapsed >= std::time::Duration::from_secs(1));
    assert!(elapsed < std::time::Duration::from_millis(1200));
}
