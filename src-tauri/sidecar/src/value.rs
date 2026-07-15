use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::{json, Value};
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row, TypeInfo, ValueRef};

/// JS's Number.MAX_SAFE_INTEGER — larger integers become strings so the JSON
/// wire format never silently loses precision.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn num_i64(v: i64) -> Value {
    if v.abs() <= MAX_SAFE {
        Value::from(v)
    } else {
        Value::from(v.to_string())
    }
}

fn num_u64(v: u64) -> Value {
    if v <= MAX_SAFE as u64 {
        Value::from(v)
    } else {
        Value::from(v.to_string())
    }
}

fn num_f64(v: f64) -> Value {
    serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

/// Node Buffer JSON shape: {"type":"Buffer","data":[...]} — what the JS
/// drivers produced via JSON.stringify for binary columns.
fn buffer_json(bytes: Vec<u8>) -> Value {
    json!({ "type": "Buffer", "data": bytes })
}

fn iso_utc(dt: DateTime<Utc>) -> Value {
    Value::from(dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn iso_naive(dt: NaiveDateTime) -> Value {
    Value::from(dt.format("%Y-%m-%dT%H:%M:%S%.3f").to_string())
}

pub fn column_names<R: Row>(row: &R) -> Vec<String> {
    row.columns().iter().map(|c| c.name().to_string()).collect()
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

pub fn pg_value(row: &PgRow, i: usize) -> Value {
    if let Ok(raw) = row.try_get_raw(i) {
        if raw.is_null() {
            return Value::Null;
        }
        let type_name = raw.type_info().name().to_string();
        return pg_decode(row, i, &type_name);
    }
    Value::Null
}

fn pg_decode(row: &PgRow, i: usize, type_name: &str) -> Value {
    match type_name {
        "BOOL" => row.try_get::<bool, _>(i).map(Value::from).unwrap_or(Value::Null),
        "INT2" => row.try_get::<i16, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "INT4" => row.try_get::<i32, _>(i).map(Value::from).unwrap_or(Value::Null),
        "INT8" => row.try_get::<i64, _>(i).map(num_i64).unwrap_or(Value::Null),
        "OID" => row.try_get::<sqlx::postgres::types::Oid, _>(i).map(|v| Value::from(v.0)).unwrap_or(Value::Null),
        "FLOAT4" => row.try_get::<f32, _>(i).map(|v| num_f64(v as f64)).unwrap_or(Value::Null),
        "FLOAT8" => row.try_get::<f64, _>(i).map(num_f64).unwrap_or(Value::Null),
        "NUMERIC" => row
            .try_get::<BigDecimal, _>(i)
            .map(|v| Value::from(v.to_string()))
            .unwrap_or_else(|_| pg_fallback(row, i)),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" | "UNKNOWN" => {
            row.try_get::<String, _>(i).map(Value::from).unwrap_or_else(|_| pg_fallback(row, i))
        }
        "BYTEA" => row.try_get::<Vec<u8>, _>(i).map(buffer_json).unwrap_or(Value::Null),
        "TIMESTAMPTZ" => row.try_get::<DateTime<Utc>, _>(i).map(iso_utc).unwrap_or(Value::Null),
        "TIMESTAMP" => row.try_get::<NaiveDateTime, _>(i).map(iso_naive).unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<NaiveDate, _>(i)
            .map(|v| Value::from(v.format("%Y-%m-%d").to_string()))
            .unwrap_or(Value::Null),
        "TIME" | "TIMETZ" => row
            .try_get::<NaiveTime, _>(i)
            .map(|v| Value::from(v.format("%H:%M:%S%.f").to_string()))
            .unwrap_or_else(|_| pg_fallback(row, i)),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(i)
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        "JSON" | "JSONB" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
        name if name.ends_with("[]") => pg_array(row, i, name),
        _ => pg_fallback(row, i),
    }
}

fn pg_array(row: &PgRow, i: usize, type_name: &str) -> Value {
    match type_name {
        "TEXT[]" | "VARCHAR[]" | "NAME[]" | "BPCHAR[]" => row
            .try_get::<Vec<String>, _>(i)
            .map(Value::from)
            .unwrap_or_else(|_| pg_array_fallback(row, i)),
        "INT2[]" => row.try_get::<Vec<i16>, _>(i).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT4[]" => row.try_get::<Vec<i32>, _>(i).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT8[]" => row
            .try_get::<Vec<i64>, _>(i)
            .map(|v| Value::Array(v.into_iter().map(num_i64).collect()))
            .unwrap_or(Value::Null),
        "FLOAT8[]" => row.try_get::<Vec<f64>, _>(i).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT4[]" => row.try_get::<Vec<f32>, _>(i).map(|v| json!(v)).unwrap_or(Value::Null),
        "BOOL[]" => row.try_get::<Vec<bool>, _>(i).map(|v| json!(v)).unwrap_or(Value::Null),
        _ => pg_array_fallback(row, i),
    }
}

fn pg_array_fallback(row: &PgRow, i: usize) -> Value {
    // Enum arrays and other unknown array element types: labels arrive as text.
    row.try_get_unchecked::<Vec<String>, _>(i).map(Value::from).unwrap_or(Value::Null)
}

fn pg_fallback(row: &PgRow, i: usize) -> Value {
    // Enums and other unknown types whose binary representation is their text
    // label decode fine as String when the type check is bypassed.
    if let Ok(v) = row.try_get_unchecked::<String, _>(i) {
        return Value::from(v);
    }
    if let Ok(v) = row.try_get_unchecked::<i64, _>(i) {
        return num_i64(v);
    }
    if let Ok(v) = row.try_get_unchecked::<f64, _>(i) {
        return num_f64(v);
    }
    Value::Null
}

pub fn pg_row_values(row: &PgRow) -> Vec<Value> {
    (0..row.columns().len()).map(|i| pg_value(row, i)).collect()
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

pub fn mysql_value(row: &MySqlRow, i: usize) -> Value {
    if let Ok(raw) = row.try_get_raw(i) {
        if raw.is_null() {
            return Value::Null;
        }
        let type_name = raw.type_info().name().to_string();
        return mysql_decode(row, i, &type_name);
    }
    Value::Null
}

fn mysql_decode(row: &MySqlRow, i: usize, type_name: &str) -> Value {
    match type_name {
        // mysql2 returns tinyint(1) as 0/1 numbers, not booleans.
        "BOOLEAN" => row.try_get::<bool, _>(i).map(|v| Value::from(v as u8)).unwrap_or(Value::Null),
        "TINYINT" => row.try_get::<i8, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "SMALLINT" => row.try_get::<i16, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "MEDIUMINT" | "INT" => row.try_get::<i32, _>(i).map(Value::from).unwrap_or(Value::Null),
        "BIGINT" => row.try_get::<i64, _>(i).map(num_i64).unwrap_or(Value::Null),
        "TINYINT UNSIGNED" => row.try_get::<u8, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "SMALLINT UNSIGNED" => row.try_get::<u16, _>(i).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "MEDIUMINT UNSIGNED" | "INT UNSIGNED" => row.try_get::<u32, _>(i).map(Value::from).unwrap_or(Value::Null),
        "BIGINT UNSIGNED" => row.try_get::<u64, _>(i).map(num_u64).unwrap_or(Value::Null),
        "YEAR" => row.try_get::<u16, _>(i).map(|v| Value::from(v)).unwrap_or_else(|_| mysql_fallback(row, i)),
        "FLOAT" => row.try_get::<f32, _>(i).map(|v| num_f64(v as f64)).unwrap_or(Value::Null),
        "DOUBLE" => row.try_get::<f64, _>(i).map(num_f64).unwrap_or(Value::Null),
        // mysql2 returns DECIMAL as strings by default.
        "DECIMAL" => row
            .try_get::<BigDecimal, _>(i)
            .map(|v| Value::from(v.to_string()))
            .unwrap_or_else(|_| mysql_fallback(row, i)),
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            row.try_get::<String, _>(i).map(Value::from).unwrap_or_else(|_| mysql_fallback(row, i))
        }
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT" | "GEOMETRY" => {
            row.try_get::<Vec<u8>, _>(i).map(buffer_json).unwrap_or(Value::Null)
        }
        "TIMESTAMP" => row.try_get::<DateTime<Utc>, _>(i).map(iso_utc).unwrap_or_else(|_| mysql_fallback(row, i)),
        "DATETIME" => row.try_get::<NaiveDateTime, _>(i).map(iso_naive).unwrap_or_else(|_| mysql_fallback(row, i)),
        "DATE" => row
            .try_get::<NaiveDate, _>(i)
            .map(|v| Value::from(v.format("%Y-%m-%d").to_string()))
            .unwrap_or_else(|_| mysql_fallback(row, i)),
        "TIME" => row
            .try_get::<NaiveTime, _>(i)
            .map(|v| Value::from(v.format("%H:%M:%S%.f").to_string()))
            .unwrap_or_else(|_| mysql_fallback(row, i)),
        "JSON" => row.try_get::<Value, _>(i).unwrap_or_else(|_| mysql_fallback(row, i)),
        _ => mysql_fallback(row, i),
    }
}

fn mysql_fallback(row: &MySqlRow, i: usize) -> Value {
    if let Ok(v) = row.try_get_unchecked::<String, _>(i) {
        return Value::from(v);
    }
    if let Ok(v) = row.try_get_unchecked::<i64, _>(i) {
        return num_i64(v);
    }
    if let Ok(v) = row.try_get_unchecked::<f64, _>(i) {
        return num_f64(v);
    }
    if let Ok(v) = row.try_get_unchecked::<Vec<u8>, _>(i) {
        return buffer_json(v);
    }
    Value::Null
}

pub fn mysql_row_values(row: &MySqlRow) -> Vec<Value> {
    (0..row.columns().len()).map(|i| mysql_value(row, i)).collect()
}

// ---------------------------------------------------------------------------
// SQLite (dynamically typed — match on the value's storage class)
// ---------------------------------------------------------------------------

pub fn sqlite_value(row: &SqliteRow, i: usize) -> Value {
    if let Ok(raw) = row.try_get_raw(i) {
        if raw.is_null() {
            return Value::Null;
        }
        let type_name = raw.type_info().name().to_string();
        return match type_name.as_str() {
            "INTEGER" | "BOOLEAN" | "INT4" | "INT8" => {
                row.try_get_unchecked::<i64, _>(i).map(num_i64).unwrap_or(Value::Null)
            }
            "REAL" => row.try_get_unchecked::<f64, _>(i).map(num_f64).unwrap_or(Value::Null),
            "BLOB" => row.try_get_unchecked::<Vec<u8>, _>(i).map(buffer_json).unwrap_or(Value::Null),
            _ => sqlite_fallback(row, i),
        };
    }
    Value::Null
}

fn sqlite_fallback(row: &SqliteRow, i: usize) -> Value {
    if let Ok(v) = row.try_get_unchecked::<String, _>(i) {
        return Value::from(v);
    }
    if let Ok(v) = row.try_get_unchecked::<i64, _>(i) {
        return num_i64(v);
    }
    if let Ok(v) = row.try_get_unchecked::<f64, _>(i) {
        return num_f64(v);
    }
    if let Ok(v) = row.try_get_unchecked::<Vec<u8>, _>(i) {
        return buffer_json(v);
    }
    Value::Null
}

pub fn sqlite_row_values(row: &SqliteRow) -> Vec<Value> {
    (0..row.columns().len()).map(|i| sqlite_value(row, i)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_integers_become_strings() {
        assert_eq!(num_i64(42), json!(42));
        assert_eq!(num_i64(9_007_199_254_740_992), json!("9007199254740992"));
        assert_eq!(num_u64(u64::MAX), json!(u64::MAX.to_string()));
    }

    #[test]
    fn non_finite_floats_become_null() {
        assert_eq!(num_f64(f64::NAN), Value::Null);
        assert_eq!(num_f64(1.5), json!(1.5));
    }

    #[test]
    fn buffers_serialize_like_node() {
        assert_eq!(
            buffer_json(vec![1, 2, 255]),
            json!({"type": "Buffer", "data": [1, 2, 255]})
        );
    }
}
