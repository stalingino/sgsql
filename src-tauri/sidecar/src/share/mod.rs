//! Sharing a running connection with an AI agent over MCP, scoped to a table
//! allowlist and a read-only / read-write mode.

pub mod exec;
pub mod guard;
pub mod mcp;
pub mod registry;
pub mod server;
pub mod types;
