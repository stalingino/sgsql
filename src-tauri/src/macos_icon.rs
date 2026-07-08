use std::ptr::NonNull;
use std::sync::Once;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{class, msg_send, AnyThread};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::{
    MainThreadMarker, NSData, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString,
    NSUserDefaults,
};
use tauri::AppHandle;

static INSTALL_OBSERVER: Once = Once::new();
static LIGHT_ICON: &[u8] = include_bytes!("../icons/icon.png");
static DARK_ICON: &[u8] = include_bytes!("../icons/icon-dark.png");

pub fn init(app: &AppHandle) {
    refresh(app);
    install_appearance_observer(app);
    refresh_after_delay(app, Duration::from_millis(500));
}

pub fn refresh(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            set_dock_icon(mtm);
        }
    });
}

fn refresh_after_delay(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        refresh(&app);
    });
}

fn install_appearance_observer(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        INSTALL_OBSERVER.call_once(|| {
            if let Some(mtm) = MainThreadMarker::new() {
                add_appearance_observer(mtm);
            }
        });
    });
}

fn is_dark_mode() -> bool {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("AppleInterfaceStyle");
    defaults.stringForKey(&key).is_some()
}

fn set_dock_icon(mtm: MainThreadMarker) {
    let app = NSApplication::sharedApplication(mtm);
    let bytes = if is_dark_mode() { DARK_ICON } else { LIGHT_ICON };
    let data = NSData::with_bytes(bytes);

    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { app.setApplicationIconImage(Some(&image)) };
    }
}

fn add_appearance_observer(_mtm: MainThreadMarker) {
    let center: Retained<NSNotificationCenter> =
        unsafe { msg_send![class!(NSDistributedNotificationCenter), defaultCenter] };
    let name = NSString::from_str("AppleInterfaceThemeChangedNotification");
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
        if let Some(mtm) = MainThreadMarker::new() {
            set_dock_icon(mtm);
        }
    });

    let observer: Retained<ProtocolObject<dyn NSObjectProtocol>> = unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(&name), None, None, &block)
    };

    std::mem::forget(block);
    std::mem::forget(observer);
}
