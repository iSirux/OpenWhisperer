//! Node executors, one submodule per node-type family. Each is an
//! `impl SequenceExecutor` block; the dispatch lives in [`super::engine`].

mod control_flow;
mod git;
mod github;
mod io;
mod notify;
mod prompt;
