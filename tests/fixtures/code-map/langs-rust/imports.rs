use std::fmt;
use std::collections::{HashMap, BTreeMap};
use std::path::Path as FsPath;
use serde::*;

pub fn noop() {
    let _: Option<FsPath> = None;
    let _ = fmt::Debug;
    let _: HashMap<u8, BTreeMap<u8, u8>> = HashMap::new();
}
