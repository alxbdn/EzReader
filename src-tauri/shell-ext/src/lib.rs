pub mod layout;

#[cfg(windows)]
pub mod pdf;
#[cfg(windows)]
mod preview;
#[cfg(windows)]
pub mod quicklook;
#[cfg(windows)]
mod thumbnail;
#[cfg(windows)]
pub mod viewer;

#[cfg(windows)]
pub use com::*;

#[cfg(windows)]
mod com {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
    use windows::core::{implement, Interface, Ref, BOOL, GUID, HRESULT};
    use windows::Win32::Foundation::{
        CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_POINTER, HINSTANCE, S_FALSE, S_OK,
    };
    use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
    use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
    use windows_core::IUnknown;

    pub const CLSID_THUMBNAIL: GUID = GUID::from_u128(0x5ae37068_61ba_478f_9d24_ea58e7c1ebf6);
    pub const CLSID_PREVIEW: GUID = GUID::from_u128(0x202348cf_bd0b_4eb3_91b2_c87e74f2fd32);

    static MODULE: AtomicIsize = AtomicIsize::new(0);
    static OBJECTS: AtomicUsize = AtomicUsize::new(0);
    static LOCKS: AtomicUsize = AtomicUsize::new(0);

    pub(crate) fn module() -> HINSTANCE {
        match MODULE.load(Ordering::Relaxed) {
            0 => unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) }
                .map(|m| HINSTANCE(m.0))
                .unwrap_or_default(),
            m => HINSTANCE(m as *mut c_void),
        }
    }

    pub(crate) struct Alive;

    impl Alive {
        pub(crate) fn new() -> Self {
            OBJECTS.fetch_add(1, Ordering::SeqCst);
            Alive
        }
    }

    impl Drop for Alive {
        fn drop(&mut self) {
            OBJECTS.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[implement(IClassFactory)]
    struct Factory {
        clsid: GUID,
        _alive: Alive,
    }

    impl IClassFactory_Impl for Factory_Impl {
        fn CreateInstance(
            &self,
            outer: Ref<IUnknown>,
            iid: *const GUID,
            object: *mut *mut c_void,
        ) -> windows::core::Result<()> {
            if object.is_null() || iid.is_null() {
                return Err(E_POINTER.into());
            }
            unsafe { *object = std::ptr::null_mut() };
            if outer.is_some() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            let unknown: IUnknown = if self.clsid == CLSID_THUMBNAIL {
                crate::thumbnail::ThumbnailProvider::new().into()
            } else {
                crate::preview::PreviewHandler::new().into()
            };
            unsafe { unknown.query(iid, object).ok() }
        }

        fn LockServer(&self, lock: BOOL) -> windows::core::Result<()> {
            if lock.as_bool() {
                LOCKS.fetch_add(1, Ordering::SeqCst);
            } else {
                LOCKS.fetch_sub(1, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    #[no_mangle]
    extern "system" fn DllMain(module: HINSTANCE, reason: u32, _reserved: *mut c_void) -> BOOL {
        if reason == DLL_PROCESS_ATTACH {
            MODULE.store(module.0 as isize, Ordering::Relaxed);
        }
        true.into()
    }

    /// # Safety
    /// Called by COM with valid pointers.
    #[no_mangle]
    pub unsafe extern "system" fn DllGetClassObject(
        clsid: *const GUID,
        iid: *const GUID,
        out: *mut *mut c_void,
    ) -> HRESULT {
        if clsid.is_null() || iid.is_null() || out.is_null() {
            return E_POINTER;
        }
        *out = std::ptr::null_mut();
        let clsid = *clsid;
        if clsid != CLSID_THUMBNAIL && clsid != CLSID_PREVIEW {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory { clsid, _alive: Alive::new() }.into();
        factory.query(iid, out)
    }

    #[no_mangle]
    extern "system" fn DllCanUnloadNow() -> HRESULT {
        if OBJECTS.load(Ordering::SeqCst) == 0 && LOCKS.load(Ordering::SeqCst) == 0 {
            crate::viewer::unregister_class();
            S_OK
        } else {
            S_FALSE
        }
    }
}
