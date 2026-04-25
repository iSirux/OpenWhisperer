use reqwest::Client;
use serde::{Deserialize, Serialize};

const NOTION_API: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";
const DEFAULT_DATABASE_ID: &str = "309298703b2b8083a88ed7811dd7d340";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotionCard {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<String>,
    pub size: Option<String>,
    pub category: Vec<String>,
    pub feature_area: Vec<String>,
    pub groomed: Option<String>,
    pub url: String,
}

pub struct NotionClient {
    client: Client,
    token: String,
    database_id: String,
}

impl NotionClient {
    pub fn new(token: String, database_id: Option<String>) -> Self {
        Self {
            client: Client::new(),
            token,
            database_id: database_id.unwrap_or_else(|| DEFAULT_DATABASE_ID.to_string()),
        }
    }

    pub async fn fetch_cards(
        &self,
        status_filter: Option<Vec<String>>,
    ) -> Result<Vec<NotionCard>, String> {
        let url = format!("{}/databases/{}/query", NOTION_API, self.database_id);

        let filter = status_filter.as_ref().map(|statuses| {
            if statuses.len() == 1 {
                serde_json::json!({
                    "property": "Status",
                    "status": { "equals": statuses[0] }
                })
            } else {
                let or_filters: Vec<serde_json::Value> = statuses
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "property": "Status",
                            "status": { "equals": s }
                        })
                    })
                    .collect();
                serde_json::json!({ "or": or_filters })
            }
        });

        let mut all_cards: Vec<NotionCard> = Vec::new();
        let mut start_cursor: Option<String> = None;

        loop {
            let mut body = serde_json::json!({ "page_size": 100 });
            if let Some(ref f) = filter {
                body["filter"] = f.clone();
            }
            if let Some(ref cursor) = start_cursor {
                body["start_cursor"] = serde_json::json!(cursor);
            }

            let resp = self
                .client
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.token))
                .header("Notion-Version", NOTION_VERSION)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Notion API request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("Notion API error ({}): {}", status, text));
            }

            let data: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse Notion response: {}", e))?;

            if let Some(results) = data["results"].as_array() {
                for page in results {
                    if let Some(card) = parse_card(page) {
                        all_cards.push(card);
                    }
                }
            }

            let has_more = data["has_more"].as_bool().unwrap_or(false);
            if has_more {
                start_cursor = data["next_cursor"].as_str().map(|s| s.to_string());
            } else {
                break;
            }
        }

        Ok(all_cards)
    }
}

fn parse_card(page: &serde_json::Value) -> Option<NotionCard> {
    let id = page["id"].as_str()?.to_string();
    let props = &page["properties"];

    let title = props["Project name"]["title"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|t| t["plain_text"].as_str())
        .unwrap_or("(untitled)")
        .to_string();

    let status = props["Status"]["status"]["name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let priority = props["Priority"]["select"]["name"]
        .as_str()
        .map(|s| s.to_string());

    let size = props["Size"]["select"]["name"]
        .as_str()
        .map(|s| s.to_string());

    let category = props["Category"]["multi_select"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let feature_area = props["Feature Area"]["multi_select"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let groomed = props["AI Groomed"]["select"]["name"]
        .as_str()
        .map(|s| s.to_string());

    let url = page["url"].as_str().unwrap_or("").to_string();

    Some(NotionCard {
        id,
        title,
        status,
        priority,
        size,
        category,
        feature_area,
        groomed,
        url,
    })
}
