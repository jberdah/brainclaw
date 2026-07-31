use std::fmt;

const MAX_SIZE: usize = 100;

static COUNTER: i32 = 0;

pub type NodeId = u64;

pub struct Config {
    name: String,
    size: i32,
}

pub enum Store {
    Memory,
    Disk,
}

pub trait Describe {
    fn describe(&self) -> String;
}

pub mod inner {
    pub fn helper() {}
}

pub fn new_config(name: String) -> Config {
    Config { name, size: 0 }
}

impl Config {
    pub fn describe(&self) -> String {
        let _ = fmt::Debug;
        String::new()
    }
}

macro_rules! my_macro {
    () => {};
}
