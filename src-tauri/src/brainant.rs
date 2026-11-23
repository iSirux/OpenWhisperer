//! Brainant's REST API (`/api/v1/`), for the board view: the Kanban boards a person reaches, their
//! cards, and moving a card. Authenticated with a personal access token from Brainant's Settings →
//! Access tokens; every call acts as that person, so the board's history names this app's token.
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_BASE_URL: &str = "https://brainant.ai";

/// One Kanban board (an instance of Brainant's Kanban app).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainantBoard {
    pub id: String,
    pub name: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumn {
    pub name: String,
    /// `todo`, `in_progress` or `done`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    pub id: i64,
    pub title: String,
    pub column: String,
    /// The board's own fields by name (Size, Category, Feature Area, …), as the app shows them.
    pub fields: Value,
    pub link: String,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub board: String,
    pub columns: Vec<BoardColumn>,
    pub cards: Vec<BoardCard>,
    pub link: String,
}

pub struct BrainantClient {
    client: Client,
    base_url: String,
    token: String,
}

impl BrainantClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.trim().to_string(),
        }
    }

    async fn answer(resp: reqwest::Response) -> Result<Value, String> {
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        let message = body["error"]["message"]
            .as_str()
            .or_else(|| body["error"].as_str())
            .unwrap_or("no details")
            .to_string();
        Err(format!("Brainant answered {}: {}", status.as_u16(), message))
    }

    /// `GET /api/v1/apps`: the boards (Kanban instances) the token's person reaches.
    pub async fn boards(&self) -> Result<Vec<BrainantBoard>, String> {
        let resp = self
            .client
            .get(format!("{}/api/v1/apps", self.base_url))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("Could not reach Brainant: {}", e))?;
        let body = Self::answer(resp).await?;
        let mut boards = Vec::new();
        for app in body["apps"].as_array().cloned().unwrap_or_default() {
            if app["slug"].as_str() != Some("kanban") {
                continue;
            }
            for instance in app["instances"].as_array().cloned().unwrap_or_default() {
                if let (Some(id), Some(name)) = (instance["id"].as_str(), instance["name"].as_str()) {
                    boards.push(BrainantBoard {
                        id: id.to_string(),
                        name: name.to_string(),
                        label: instance["label"].as_str().unwrap_or(name).to_string(),
                    });
                }
            }
        }
        Ok(boards)
    }

    /// `POST /api/v1/apps/:instance/tools/:tool`: the tool's own result.
    pub async fn call(&self, instance: &str, tool: &str, input: Value) -> Result<Value, String> {
        let mut url = url::Url::parse(&self.base_url).map_err(|e| format!("Bad Brainant address: {}", e))?;
        url.path_segments_mut()
            .map_err(|_| "Bad Brainant address".to_string())?
            .pop_if_empty()
            .extend(["api", "v1", "apps", instance, "tools", tool]);
        let resp = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .json(&input)
            .send()
            .await
            .map_err(|e| format!("Could not reach Brainant: {}", e))?;
        let body = Self::answer(resp).await?;
        Ok(body["result"].clone())
    }

    /// The board's columns and its cards: the open ones, or every card with `include_done`.
    pub async fn snapshot(&self, instance: &str, include_done: bool) -> Result<BoardSnapshot, String> {
        let board = self.call(instance, "board", json!({})).await?;
        let columns = board["columns"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|c| {
                Some(BoardColumn {
                    name: c["name"].as_str()?.to_string(),
                    kind: c["kind"].as_str().unwrap_or("todo").to_string(),
                })
            })
            .collect();
        let mut cards = Vec::new();
        let mut offset = 0;
        loop {
            let mut input = json!({ "limit": 100, "offset": offset });
            if !include_done {
                input["group"] = json!("open");
            }
            let page = self.call(instance, "cards_search", input).await?;
            let found = page["cards"].as_array().cloned().unwrap_or_default();
            for card in &found {
                if let (Some(id), Some(title)) = (card["id"].as_i64(), card["title"].as_str()) {
                    cards.push(BoardCard {
                        id,
                        title: title.to_string(),
                        column: card["column"].as_str().unwrap_or("").to_string(),
                        fields: card.get("fields").cloned().unwrap_or(json!({})),
                        link: card["link"].as_str().unwrap_or("").to_string(),
                        updated: card["updated"].as_str().map(|s| s.to_string()),
                    });
                }
            }
            let total = page["total"].as_i64().unwrap_or(0);
            offset += found.len() as i64;
            // Stop at the end, on an empty page, or at a sane cap.
            if found.is_empty() || offset >= total || offset >= 2000 {
                break;
            }
        }
        Ok(BoardSnapshot {
            board: board["board"].as_str().unwrap_or(instance).to_string(),
            columns,
            cards,
            link: board["link"].as_str().unwrap_or("").to_string(),
        })
    }

    /// Moves a card to a column (by name), as the token's person.
    pub async fn move_card(&self, instance: &str, card: i64, column: &str) -> Result<(), String> {
        self.call(instance, "card_move", json!({ "card": card, "column": column }))
            .await
            .map(|_| ())
    }
}
