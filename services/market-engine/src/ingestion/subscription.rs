//! Builders for the two Yellowstone subscriptions (RFC-003): a `processed`
//! discovery stream and a narrower `confirmed` stream for active
//! candidates/positions. Filters are server-side and scoped to the allowlist;
//! global Token/Jupiter/full-block subscriptions are never requested.

use std::collections::HashMap;

use yellowstone_grpc_proto::geyser::{
    CommitmentLevel, SubscribeRequest, SubscribeRequestFilterAccounts, SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions,
};

use super::allowlist::allowed_program_ids;

fn transactions_on_allowlist(extra_accounts: &[String]) -> SubscribeRequestFilterTransactions {
    let mut account_include = allowed_program_ids();
    account_include.extend_from_slice(extra_accounts);
    SubscribeRequestFilterTransactions {
        vote: Some(false),
        failed: Some(false),
        account_include,
        ..Default::default()
    }
}

/// Discovery: `processed` commitment, non-vote non-failed transactions touching
/// the allowlisted programs, plus slot updates filtered by commitment.
pub fn discovery_request() -> SubscribeRequest {
    let mut transactions = HashMap::new();
    transactions.insert("pump_discovery".to_owned(), transactions_on_allowlist(&[]));

    let mut slots = HashMap::new();
    slots.insert(
        "slots".to_owned(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            ..Default::default()
        },
    );

    SubscribeRequest {
        transactions,
        slots,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    }
}

/// Candidates/positions: `confirmed` commitment, transactions on the allowlist
/// plus the dynamically tracked accounts (mints, curves, pools, vaults, hot
/// wallet), and account updates for those specific accounts owned by the
/// allowlisted programs.
pub fn candidate_request(tracked_accounts: &[String]) -> SubscribeRequest {
    let mut transactions = HashMap::new();
    transactions.insert(
        "pump_candidates".to_owned(),
        transactions_on_allowlist(tracked_accounts),
    );

    let mut accounts = HashMap::new();
    accounts.insert(
        "pump_accounts".to_owned(),
        SubscribeRequestFilterAccounts {
            account: tracked_accounts.to_vec(),
            owner: allowed_program_ids(),
            ..Default::default()
        },
    );

    SubscribeRequest {
        transactions,
        accounts,
        commitment: Some(CommitmentLevel::Confirmed as i32),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::super::allowlist::PUMP_PROGRAM_ID;
    use super::*;

    #[test]
    fn discovery_is_processed_and_scoped_to_allowlist() {
        let request = discovery_request();
        assert_eq!(request.commitment, Some(CommitmentLevel::Processed as i32));
        let filter = request
            .transactions
            .get("pump_discovery")
            .expect("discovery filter");
        assert_eq!(filter.vote, Some(false));
        assert_eq!(filter.failed, Some(false));
        assert!(
            filter
                .account_include
                .iter()
                .any(|id| id == PUMP_PROGRAM_ID)
        );
        assert!(
            request.blocks.is_empty(),
            "must never subscribe to full blocks"
        );
    }

    #[test]
    fn candidate_request_is_confirmed_and_tracks_accounts() {
        let tracked = vec!["MintPubkey11111111111111111111111111111111".to_owned()];
        let request = candidate_request(&tracked);
        assert_eq!(request.commitment, Some(CommitmentLevel::Confirmed as i32));
        let accounts = request
            .accounts
            .get("pump_accounts")
            .expect("accounts filter");
        assert!(accounts.account.contains(&tracked[0]));
        let filter = request
            .transactions
            .get("pump_candidates")
            .expect("candidate filter");
        assert!(filter.account_include.contains(&tracked[0]));
        assert!(
            filter
                .account_include
                .iter()
                .any(|id| id == PUMP_PROGRAM_ID)
        );
    }
}
