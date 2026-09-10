use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectorySearchMatch {
    path: String,
    line: usize,
    preview: String,
}

#[tauri::command]
fn search_directory(root: String, query: String) -> Result<Vec<DirectorySearchMatch>, String> {
    let output = std::process::Command::new("rg")
        .args([
            "--json",
            "--ignore-case",
            "--line-number",
            "--color",
            "never",
            "--max-count",
            "100",
            "--",
            &query,
            &root,
        ])
        .output()
        .map_err(|error| format!("Could not run ripgrep: {error}"))?;

    // Ripgrep uses exit code 1 when no files match, which is not an error here.
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    let mut matches = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value["type"] != "match" {
            continue;
        }

        let data = &value["data"];
        let (Some(path), Some(line_number), Some(text)) = (
            data["path"]["text"].as_str(),
            data["line_number"].as_u64(),
            data["lines"]["text"].as_str(),
        ) else {
            continue;
        };
        matches.push(DirectorySearchMatch {
            path: path.to_owned(),
            line: line_number as usize,
            preview: text.trim().to_owned(),
        });
        if matches.len() == 100 {
            break;
        }
    }

    Ok(matches)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![search_directory])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let close_tab =
                    MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &Submenu::with_items(
                            app,
                            "tekst",
                            true,
                            &[
                                &PredefinedMenuItem::about(app, None, None)?,
                                &PredefinedMenuItem::separator(app)?,
                                &PredefinedMenuItem::services(app, None)?,
                                &PredefinedMenuItem::separator(app)?,
                                &PredefinedMenuItem::hide(app, None)?,
                                &PredefinedMenuItem::hide_others(app, None)?,
                                &PredefinedMenuItem::separator(app)?,
                                &PredefinedMenuItem::quit(app, None)?,
                            ],
                        )?,
                        &Submenu::with_items(app, "File", true, &[&close_tab])?,
                        &Submenu::with_items(
                            app,
                            "Edit",
                            true,
                            &[
                                &PredefinedMenuItem::undo(app, None)?,
                                &PredefinedMenuItem::redo(app, None)?,
                                &PredefinedMenuItem::separator(app)?,
                                &PredefinedMenuItem::cut(app, None)?,
                                &PredefinedMenuItem::copy(app, None)?,
                                &PredefinedMenuItem::paste(app, None)?,
                                &PredefinedMenuItem::select_all(app, None)?,
                            ],
                        )?,
                        &Submenu::with_items(
                            app,
                            "View",
                            true,
                            &[&PredefinedMenuItem::fullscreen(app, None)?],
                        )?,
                        &Submenu::with_items(
                            app,
                            "Window",
                            true,
                            &[
                                &PredefinedMenuItem::minimize(app, None)?,
                                &PredefinedMenuItem::maximize(app, None)?,
                            ],
                        )?,
                    ],
                )?;
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "close-tab" {
                let _ = app.emit("close-tab", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
