use std::path::Path;
#[allow(dead_code)] // The integration test imports only the classifier subset.
#[path = "../src/classifier.rs"]
mod classifier;

#[test]
fn current_product_selection_and_retired_exclusion() {
    let files = vec![
        "native/windows/source-packager-rust/src/main.rs".into(),
        "dashboard/server.py".into(),
        "office/README.md".into(),
        "native/desktop-bridge/src/office.rs".into(),
        "adapters/claude-code/agents/ghost-retired.md".into(),
        "native/gui-plugins/openchamber/plugin.js".into(),
    ];
    let p = classifier::Partition::for_files(&files);
    let selected = p.selected_for_windows(2).unwrap();
    assert!(selected.iter().all(|n| Path::new(n).is_relative()));
    assert!(selected
        .iter()
        .all(|n| !classifier::windows_retired_source(n)));
    assert!(selected.iter().any(|n| n == "office/README.md"));
    assert!(p.selected_for_windows(3).is_err());
    assert!(p.selected_for_windows(4).is_err());
}
