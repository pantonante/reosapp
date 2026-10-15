use std::process::Command;

/// Extended attribute Google Drive for desktop sets on every synced file,
/// holding the Drive item ID.
const DRIVE_ITEM_ID_XATTR: &str = "com.google.drivefs.item-id#S";

fn drive_item_id(path: &str) -> Result<String, String> {
    let out = Command::new("xattr")
        .arg("-p")
        .arg(DRIVE_ITEM_ID_XATTR)
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || id.is_empty() {
        return Err("This PDF has no Google Drive ID yet (not synced to Drive?)".to_string());
    }
    Ok(id)
}

/// Opens the macOS AirDrop sheet with the Google Drive link of the file at
/// `path`. Returns the link.
#[tauri::command]
pub fn airdrop_drive_link(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let url = format!("https://drive.google.com/file/d/{}/view", drive_item_id(&path)?);
    #[cfg(target_os = "macos")]
    {
        let link = url.clone();
        app.run_on_main_thread(move || {
            use objc2_app_kit::{NSSharingService, NSSharingServiceNameSendViaAirDrop};
            use objc2_foundation::{NSArray, NSString, NSURL};
            let Some(ns_url) = NSURL::URLWithString(&NSString::from_str(&link)) else {
                return;
            };
            let items = NSArray::from_retained_slice(&[ns_url]);
            let Some(service) =
                NSSharingService::sharingServiceNamed(unsafe { NSSharingServiceNameSendViaAirDrop })
            else {
                return;
            };
            // performWithItems takes an untyped NSArray; NSURL is a valid item.
            unsafe { service.performWithItems(items.cast_unchecked()) };
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(url)
}
