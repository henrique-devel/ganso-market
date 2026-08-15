from __future__ import annotations

import base64
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "rfc001a_manifest.py"
SPEC = importlib.util.spec_from_file_location("rfc001a_manifest", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load RFC-001A manifest validator")
rfc001a_manifest = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rfc001a_manifest
SPEC.loader.exec_module(rfc001a_manifest)


def host_key_fingerprint(seed: bytes = b"h") -> str:
    digest = (seed * 32)[:32]
    encoded = base64.b64encode(digest).decode("ascii").rstrip("=")
    return "SHA256:" + encoded


def valid_manifest(*, include_approval: bool = True) -> dict[str, object]:
    manifest: dict[str, object] = {
        "schema_version": 1,
        "identity": {
            "user": "ganso",
            "ipv4": "178.105.65.251",
            "hostname": "ganso-cpx42-01",
            "server_id": "12345678",
            "client_key_md5": rfc001a_manifest.EXPECTED_CLIENT_KEY_MD5,
            "host_key_sha256": host_key_fingerprint(),
        },
        "target": {
            "path": "/home/ganso/ganso-bot",
            "owner": "ganso",
            "shared": False,
            "symlink_detected": False,
            "mount_detected": False,
        },
        "preserve_paths": ["/home/ganso/ganso-market"],
        "resources": {
            "containers": [
                {
                    "id": rfc001a_manifest.AUTHORIZED_VOLUME_CONSUMER_ID,
                    "name": rfc001a_manifest.AUTHORIZED_VOLUME_CONSUMER_NAME,
                    "image_id": "sha256:" + "b" * 64,
                    "compose_project": "ganso",
                    "status": "exited",
                    "restart_policy": "no",
                    "owner": "docker-daemon",
                    "shared": False,
                }
            ],
            "images": [
                {
                    "id": "sha256:" + "b" * 64,
                    "names": ["registry.example/ganso-bot:inventory-test"],
                    "untagged": False,
                    "owner": "docker-daemon",
                    "shared": False,
                }
            ],
            "networks": [
                {
                    "id": "c" * 64,
                    "name": "ganso_default",
                    "compose_project": "ganso",
                    "attached_containers": 0,
                    "owner": "docker-daemon",
                    "shared": False,
                }
            ],
            "volumes": [
                {
                    "name": name,
                    "owner": "docker-daemon",
                    "shared": False,
                    "compose_project": "ganso",
                    "driver": "local",
                    "scope": "local",
                    "inventory_consumers": [],
                }
                for name in sorted(rfc001a_manifest.EXPECTED_COMPOSE_VOLUMES)
            ]
            + [
                {
                    "name": rfc001a_manifest.AUTHORIZED_UNLABELED_VOLUME,
                    "owner": "docker-daemon",
                    "shared": False,
                    "compose_project": None,
                    "driver": "local",
                    "scope": "local",
                    "size_bytes": 0,
                    "inventory_consumers": [
                        {
                            "container_id": (rfc001a_manifest.AUTHORIZED_VOLUME_CONSUMER_ID),
                            "container_name": (rfc001a_manifest.AUTHORIZED_VOLUME_CONSUMER_NAME),
                            "compose_project": "ganso",
                            "status": "exited",
                            "restart_policy": "no",
                            "mount_type": "volume",
                            "mount_path": "/data",
                            "rw": True,
                        }
                    ],
                }
            ],
            "units": [{"id": "ganso-bot.service", "owner": "root", "shared": False}],
            "timers": [{"id": "ganso-bot.timer", "owner": "root", "shared": False}],
            "crons": [{"id": "root:line-3", "owner": "root", "shared": False}],
            "docker_configs": [
                {
                    "id": "config-id-1",
                    "name": "ganso-config",
                    "owner": "docker-daemon",
                    "shared": False,
                }
            ],
            "docker_secrets": [
                {
                    "id": "secret-id-1",
                    "name": "ganso-secret",
                    "owner": "docker-daemon",
                    "shared": False,
                }
            ],
        },
        "gates": {gate: True for gate in rfc001a_manifest.REQUIRED_GATES},
    }
    if include_approval:
        manifest["approval"] = {"approved": True}
    return manifest


class ManifestValidationTests(unittest.TestCase):
    def assert_rejected(
        self,
        manifest: object,
        code: str,
        *,
        require_approval: bool = False,
    ) -> None:
        with self.assertRaises(rfc001a_manifest.ManifestValidationError) as raised:
            rfc001a_manifest.validate_manifest(
                manifest,
                require_approval=require_approval,
            )
        self.assertEqual(raised.exception.code, code)

    def test_valid_manifest_passes_with_required_approval(self) -> None:
        rfc001a_manifest.validate_manifest(
            valid_manifest(),
            require_approval=True,
        )

    def test_user_or_ipv4_divergence_is_rejected(self) -> None:
        cases = (
            ("user", "another-user", "identity-user-mismatch"),
            ("ipv4", "192.0.2.1", "identity-ipv4-mismatch"),
        )
        for field, value, code in cases:
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["identity"][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_hostname_and_server_id_must_be_literal_non_placeholders(self) -> None:
        cases = (
            ("hostname", "unknown", "identity-hostname-not-literal"),
            ("hostname", "$HOSTNAME", "identity-hostname-not-literal"),
            ("hostname", "bad host", "identity-hostname-not-literal"),
            ("server_id", "server-id", "identity-server-id-not-literal"),
            ("server_id", "<SERVER_ID>", "identity-server-id-not-literal"),
            ("server_id", "", "identity-server-id-not-literal"),
        )
        for field, value, code in cases:
            with self.subTest(field=field, value=value):
                manifest = valid_manifest()
                manifest["identity"][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_identity_fields_are_all_required(self) -> None:
        fields = (
            "user",
            "ipv4",
            "hostname",
            "server_id",
            "client_key_md5",
            "host_key_sha256",
        )
        for field in fields:
            with self.subTest(field=field):
                manifest = valid_manifest()
                del manifest["identity"][field]  # type: ignore[index]
                self.assert_rejected(manifest, "identity-fields-invalid")

    def test_client_key_md5_must_match_expected_fingerprint(self) -> None:
        manifest = valid_manifest()
        manifest["identity"]["client_key_md5"] = (  # type: ignore[index]
            "MD5:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"
        )
        self.assert_rejected(manifest, "identity-client-key-md5-mismatch")

    def test_host_key_sha256_requires_canonical_unpadded_digest(self) -> None:
        cases = (
            "SHA256:short",
            host_key_fingerprint() + "=",
            "SHA256:" + "A" * 42 + "B",
            rfc001a_manifest.EXPECTED_CLIENT_KEY_MD5,
        )
        for fingerprint in cases:
            with self.subTest(fingerprint=fingerprint):
                manifest = valid_manifest()
                manifest["identity"]["host_key_sha256"] = fingerprint  # type: ignore[index]
                self.assert_rejected(manifest, "identity-host-key-sha256-invalid")

    def test_host_identity_literals_are_not_pinned_to_fixture_values(self) -> None:
        manifest = valid_manifest()
        manifest["identity"]["hostname"] = "srv-42.example.internal"  # type: ignore[index]
        manifest["identity"]["server_id"] = "98765432"  # type: ignore[index]
        manifest["identity"]["host_key_sha256"] = host_key_fingerprint(b"z")  # type: ignore[index]
        rfc001a_manifest.validate_manifest(manifest)

    def test_wrong_parent_and_glob_paths_are_rejected(self) -> None:
        cases = (
            ("/srv/ganso-bot", "target-path-mismatch"),
            ("/home/ganso", "target-overlaps-preserved-path"),
            ("/home/ganso/ganso-*", "target-path-not-literal"),
            ("/home/ganso/ganso-bot/..", "target-path-not-literal"),
        )
        for path, code in cases:
            with self.subTest(path=path):
                manifest = valid_manifest()
                manifest["target"]["path"] = path  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_signaled_symlink_or_mount_is_rejected(self) -> None:
        cases = (
            ("symlink_detected", "target-symlink-detected"),
            ("mount_detected", "target-mount-detected"),
        )
        for field, code in cases:
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["target"][field] = True  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_non_literal_resource_ids_are_rejected(self) -> None:
        for resource_id in (
            "*",
            "$IMAGE_ID",
            "sha256:abc def",
            "../container",
            "TODO",
            "a" * 12,
        ):
            with self.subTest(resource_id=resource_id):
                manifest = valid_manifest()
                manifest["resources"]["containers"][0]["id"] = resource_id  # type: ignore[index]
                self.assert_rejected(manifest, "resource-id-not-literal")

    def test_docker_object_and_image_ids_must_be_full(self) -> None:
        cases = (
            ("containers", "id", "a" * 12, "resource-id-not-literal"),
            (
                "containers",
                "image_id",
                "sha256:" + "b" * 12,
                "container-image-id-not-literal",
            ),
            ("images", "id", "ganso-bot:latest", "resource-id-not-literal"),
            ("networks", "id", "c" * 12, "resource-id-not-literal"),
        )
        for kind, field, value, code in cases:
            with self.subTest(kind=kind, field=field):
                manifest = valid_manifest()
                manifest["resources"][kind][0][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_container_contract_is_strict(self) -> None:
        cases = (
            ("name", "ganso-*", "resource-name-not-literal"),
            ("image_id", "$IMAGE_ID", "container-image-id-not-literal"),
            ("compose_project", "another", "container-compose-project-mismatch"),
            ("status", "running", "container-not-exited"),
            ("restart_policy", "always", "container-restart-policy-enabled"),
        )
        for field, value, code in cases:
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["resources"]["containers"][0][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

        required_fields = (
            "id",
            "name",
            "image_id",
            "compose_project",
            "status",
            "restart_policy",
            "owner",
            "shared",
        )
        for field in required_fields:
            with self.subTest(missing=field):
                manifest = valid_manifest()
                del manifest["resources"]["containers"][0][field]  # type: ignore[index]
                self.assert_rejected(manifest, "resource-fields-invalid")

    def test_container_ids_and_names_are_distinct_and_unique(self) -> None:
        same = valid_manifest()
        container = same["resources"]["containers"][0]  # type: ignore[index]
        container["name"] = container["id"]
        self.assert_rejected(same, "container-name-id-not-distinct")

        duplicate_id = valid_manifest()
        second = copy.deepcopy(duplicate_id["resources"]["containers"][0])  # type: ignore[index]
        second["name"] = "ganso-dashboard-1"
        duplicate_id["resources"]["containers"].append(second)  # type: ignore[index]
        self.assert_rejected(duplicate_id, "resource-id-duplicate")

        duplicate_name = valid_manifest()
        second = copy.deepcopy(duplicate_name["resources"]["containers"][0])  # type: ignore[index]
        second["id"] = "d" * 64
        duplicate_name["resources"]["containers"].append(second)  # type: ignore[index]
        self.assert_rejected(duplicate_name, "resource-name-duplicate")

    def test_image_names_are_literal_and_unique(self) -> None:
        cases = (
            ([], "image-untagged-state-mismatch"),
            ("ganso-bot:latest", "image-names-invalid"),
            (["ganso-*"], "resource-name-not-literal"),
            (["ganso-bot:latest", "ganso-bot:latest"], "image-name-duplicate"),
        )
        for names, code in cases:
            with self.subTest(names=names):
                manifest = valid_manifest()
                manifest["resources"]["images"][0]["names"] = names  # type: ignore[index]
                self.assert_rejected(manifest, code)

        duplicate_id = valid_manifest()
        second = copy.deepcopy(duplicate_id["resources"]["images"][0])  # type: ignore[index]
        second["names"] = ["ganso-dashboard:inventory-test"]
        duplicate_id["resources"]["images"].append(second)  # type: ignore[index]
        self.assert_rejected(duplicate_id, "resource-id-duplicate")

    def test_untagged_image_is_explicit_and_does_not_invent_a_name(self) -> None:
        manifest = valid_manifest()
        image = manifest["resources"]["images"][0]  # type: ignore[index]
        image["names"] = []
        image["untagged"] = True
        rfc001a_manifest.validate_manifest(manifest)

        tagged_as_untagged = valid_manifest()
        tagged_as_untagged["resources"]["images"][0]["untagged"] = True  # type: ignore[index]
        self.assert_rejected(tagged_as_untagged, "image-untagged-state-mismatch")

        invalid_state = valid_manifest()
        invalid_state["resources"]["images"][0]["untagged"] = "false"  # type: ignore[index]
        self.assert_rejected(invalid_state, "image-untagged-state-invalid")

        missing_state = valid_manifest()
        del missing_state["resources"]["images"][0]["untagged"]  # type: ignore[index]
        self.assert_rejected(missing_state, "resource-fields-invalid")

    def test_network_is_absent_or_exact_exclusive_detached_ganso_default(self) -> None:
        absent = valid_manifest()
        absent["resources"]["networks"] = []  # type: ignore[index]
        rfc001a_manifest.validate_manifest(absent)

        cases = (
            ("name", "another_default", "network-name-mismatch"),
            ("compose_project", "another", "network-compose-project-mismatch"),
            ("attached_containers", 1, "resource-has-attached-containers"),
            ("attached_containers", False, "attached-containers-state-invalid"),
        )
        for field, value, code in cases:
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["resources"]["networks"][0][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

        multiple = valid_manifest()
        multiple["resources"]["networks"].append(  # type: ignore[index]
            copy.deepcopy(multiple["resources"]["networks"][0])  # type: ignore[index]
        )
        self.assert_rejected(multiple, "network-set-invalid")

    def test_every_resource_kind_rejects_shared_targets(self) -> None:
        for kind in rfc001a_manifest.RESOURCE_KINDS:
            with self.subTest(kind=kind):
                manifest = valid_manifest()
                entries = manifest["resources"][kind]  # type: ignore[index]
                self.assertTrue(entries)
                entries[0]["shared"] = True
                self.assert_rejected(manifest, "resource-is-shared")

    def test_target_and_every_resource_require_literal_owner(self) -> None:
        missing_target = valid_manifest()
        del missing_target["target"]["owner"]  # type: ignore[index]
        self.assert_rejected(missing_target, "target-fields-invalid")

        placeholder_target = valid_manifest()
        placeholder_target["target"]["owner"] = "unknown"  # type: ignore[index]
        self.assert_rejected(placeholder_target, "owner-not-literal")

        alternate_target_owner = valid_manifest()
        alternate_target_owner["target"]["owner"] = "root"  # type: ignore[index]
        rfc001a_manifest.validate_manifest(alternate_target_owner)

        for kind in rfc001a_manifest.RESOURCE_KINDS:
            with self.subTest(kind=kind, state="missing"):
                manifest = valid_manifest()
                del manifest["resources"][kind][0]["owner"]  # type: ignore[index]
                self.assert_rejected(manifest, "resource-fields-invalid")
            with self.subTest(kind=kind, state="placeholder"):
                manifest = valid_manifest()
                manifest["resources"][kind][0]["owner"] = "$OWNER"  # type: ignore[index]
                self.assert_rejected(manifest, "owner-not-literal")

    def test_target_must_be_explicitly_exclusive(self) -> None:
        shared = valid_manifest()
        shared["target"]["shared"] = True  # type: ignore[index]
        self.assert_rejected(shared, "target-is-shared")

        ambiguous = valid_manifest()
        ambiguous["target"]["shared"] = "false"  # type: ignore[index]
        self.assert_rejected(ambiguous, "target-shared-state-invalid")

    def test_expected_volume_requires_exact_compose_project(self) -> None:
        for compose_project in (None, "Ganso", "another-project", ""):
            with self.subTest(compose_project=compose_project):
                manifest = valid_manifest()
                volume = manifest["resources"]["volumes"][0]  # type: ignore[index]
                if compose_project is None:
                    del volume["compose_project"]
                    code = "resource-fields-invalid"
                else:
                    volume["compose_project"] = compose_project
                    code = "volume-compose-project-mismatch"
                self.assert_rejected(manifest, code)

        for field, value, code in (
            ("driver", "overlay", "volume-driver-mismatch"),
            ("scope", "global", "volume-scope-mismatch"),
        ):
            with self.subTest(field=field):
                manifest = valid_manifest()
                manifest["resources"]["volumes"][0][field] = value  # type: ignore[index]
                self.assert_rejected(manifest, code)

    def test_volume_inventory_consumers_are_literal_and_crossed_with_containers(self) -> None:
        manifest = valid_manifest()
        compose_volume = manifest["resources"]["volumes"][0]  # type: ignore[index]
        consumer = copy.deepcopy(
            manifest["resources"]["volumes"][-1]["inventory_consumers"][0]  # type: ignore[index]
        )
        consumer["mount_path"] = "/var/lib/postgresql/data"
        compose_volume["inventory_consumers"] = [consumer]
        rfc001a_manifest.validate_manifest(manifest)

        inventory_mismatch = copy.deepcopy(manifest)
        volume = inventory_mismatch["resources"]["volumes"][0]  # type: ignore[index]
        volume["inventory_consumers"][0]["container_id"] = "e" * 64
        self.assert_rejected(
            inventory_mismatch,
            "volume-consumer-not-in-container-inventory",
        )

        invalid_list = valid_manifest()
        volume = invalid_list["resources"]["volumes"][0]  # type: ignore[index]
        volume["inventory_consumers"] = 0
        self.assert_rejected(invalid_list, "inventory-consumers-invalid")

        duplicate = copy.deepcopy(manifest)
        volume = duplicate["resources"]["volumes"][0]  # type: ignore[index]
        volume["inventory_consumers"].append(copy.deepcopy(volume["inventory_consumers"][0]))
        self.assert_rejected(duplicate, "inventory-consumer-duplicate")

    def test_two_volumes_cannot_claim_the_same_container_mount(self) -> None:
        manifest = valid_manifest()
        compose_volume = manifest["resources"]["volumes"][0]  # type: ignore[index]
        compose_volume["inventory_consumers"] = [
            copy.deepcopy(
                manifest["resources"]["volumes"][-1]["inventory_consumers"][0]  # type: ignore[index]
            )
        ]
        self.assert_rejected(manifest, "volume-consumer-mount-duplicate")

    def test_ambiguous_pre_destruction_volume_counts_are_rejected(self) -> None:
        for legacy_field in ("attached_containers", "active_containers"):
            with self.subTest(legacy_field=legacy_field):
                manifest = valid_manifest()
                volume = manifest["resources"]["volumes"][0]  # type: ignore[index]
                del volume["inventory_consumers"]
                volume[legacy_field] = 0
                self.assert_rejected(manifest, "resource-fields-invalid")

    def test_expected_volume_set_must_be_complete_and_exact(self) -> None:
        missing = valid_manifest()
        missing["resources"]["volumes"].pop()  # type: ignore[index]
        self.assert_rejected(missing, "expected-volume-set-mismatch")

        additional = valid_manifest()
        additional["resources"]["volumes"].append(  # type: ignore[index]
            {
                "name": "unapproved_volume",
                "owner": "docker-daemon",
                "shared": False,
                "compose_project": "ganso",
                "driver": "local",
                "scope": "local",
                "inventory_consumers": [],
            }
        )
        self.assert_rejected(additional, "expected-volume-set-mismatch")

    def test_unlabeled_volume_requires_the_exact_authorized_identity_and_evidence(self) -> None:
        cases = (
            ("name", "e" * 64, "resource-fields-invalid"),
            ("compose_project", "ganso", "unlabeled-volume-compose-label-present"),
            ("compose_project", "", "unlabeled-volume-compose-label-present"),
            ("driver", "overlay", "volume-driver-mismatch"),
            ("scope", "global", "volume-scope-mismatch"),
            ("size_bytes", 1, "unlabeled-volume-size-mismatch"),
            ("size_bytes", False, "unlabeled-volume-size-mismatch"),
            ("inventory_consumers", [], "unlabeled-volume-consumers-invalid"),
            (
                "inventory_consumers",
                [{}, {}],
                "unlabeled-volume-consumers-invalid",
            ),
        )
        for field, value, code in cases:
            with self.subTest(field=field, value=value):
                manifest = valid_manifest()
                volume = manifest["resources"]["volumes"][-1]  # type: ignore[index]
                volume[field] = value
                self.assert_rejected(manifest, code)

        missing_label_evidence = valid_manifest()
        volume = missing_label_evidence["resources"]["volumes"][-1]  # type: ignore[index]
        del volume["compose_project"]
        self.assert_rejected(
            missing_label_evidence,
            "unlabeled-volume-fields-invalid",
        )

    def test_unlabeled_volume_requires_one_exact_inventory_redis_consumer(self) -> None:
        cases = (
            ("container_id", "e" * 12, "inventory-consumer-id-not-literal"),
            ("container_id", "e" * 64, "unlabeled-volume-consumer-mismatch"),
            ("container_name", "ganso-*", "inventory-consumer-name-not-literal"),
            ("container_name", "another-redis", "unlabeled-volume-consumer-mismatch"),
            (
                "compose_project",
                "another-project",
                "inventory-consumer-compose-project-mismatch",
            ),
            ("status", "running", "inventory-consumer-not-exited"),
            (
                "restart_policy",
                "unless-stopped",
                "inventory-consumer-restart-policy-enabled",
            ),
            ("mount_type", "bind", "inventory-consumer-mount-type-mismatch"),
            ("mount_path", "/data*", "inventory-consumer-mount-path-not-literal"),
            ("mount_path", "/another", "unlabeled-volume-consumer-mismatch"),
            ("rw", False, "unlabeled-volume-consumer-mismatch"),
            ("rw", "true", "inventory-consumer-rw-state-invalid"),
        )
        for field, value, code in cases:
            with self.subTest(field=field, value=value):
                manifest = valid_manifest()
                volume = manifest["resources"]["volumes"][-1]  # type: ignore[index]
                consumer = volume["inventory_consumers"][0]
                consumer[field] = value
                self.assert_rejected(manifest, code)

        missing_consumer_field = valid_manifest()
        volume = missing_consumer_field["resources"]["volumes"][-1]  # type: ignore[index]
        del volume["inventory_consumers"][0]["mount_path"]
        self.assert_rejected(
            missing_consumer_field,
            "inventory-consumer-fields-invalid",
        )

        inventory_mismatch = valid_manifest()
        inventory_mismatch["resources"]["containers"][0]["id"] = "e" * 64  # type: ignore[index]
        self.assert_rejected(
            inventory_mismatch,
            "volume-consumer-not-in-container-inventory",
        )

    def test_unlabeled_volume_requires_docker_owner_and_exclusive_state(self) -> None:
        placeholder_owner = valid_manifest()
        volume = placeholder_owner["resources"]["volumes"][-1]  # type: ignore[index]
        volume["owner"] = "unknown"
        self.assert_rejected(placeholder_owner, "owner-not-literal")

        alternate_literal_owner = valid_manifest()
        volume = alternate_literal_owner["resources"]["volumes"][-1]  # type: ignore[index]
        volume["owner"] = "root"
        self.assert_rejected(
            alternate_literal_owner,
            "unlabeled-volume-owner-mismatch",
        )

        shared = valid_manifest()
        volume = shared["resources"]["volumes"][-1]  # type: ignore[index]
        volume["shared"] = True
        self.assert_rejected(shared, "resource-is-shared")

    def test_docker_configs_and_secrets_are_explicit_resource_kinds(self) -> None:
        for kind in ("docker_configs", "docker_secrets"):
            with self.subTest(kind=kind):
                manifest = valid_manifest()
                del manifest["resources"][kind]  # type: ignore[index]
                self.assert_rejected(manifest, "resource-kinds-invalid")

    def test_docker_config_and_secret_ids_and_names_are_distinct_and_unique(self) -> None:
        for kind in ("docker_configs", "docker_secrets"):
            with self.subTest(kind=kind, state="same"):
                manifest = valid_manifest()
                resource = manifest["resources"][kind][0]  # type: ignore[index]
                resource["name"] = resource["id"]
                self.assert_rejected(manifest, "resource-name-id-not-distinct")

            with self.subTest(kind=kind, state="duplicate-id"):
                manifest = valid_manifest()
                second = copy.deepcopy(manifest["resources"][kind][0])  # type: ignore[index]
                second["name"] = "second-name"
                manifest["resources"][kind].append(second)  # type: ignore[index]
                self.assert_rejected(manifest, "resource-id-duplicate")

            with self.subTest(kind=kind, state="duplicate-name"):
                manifest = valid_manifest()
                second = copy.deepcopy(manifest["resources"][kind][0])  # type: ignore[index]
                second["id"] = "second-id"
                manifest["resources"][kind].append(second)  # type: ignore[index]
                self.assert_rejected(manifest, "resource-name-duplicate")

    def test_preserved_project_cannot_overlap_target(self) -> None:
        manifest = valid_manifest()
        manifest["preserve_paths"] = ["/home/ganso/ganso-bot"]
        self.assert_rejected(manifest, "target-overlaps-preserved-path")

    def test_every_gate_is_required_and_must_pass(self) -> None:
        for gate in rfc001a_manifest.REQUIRED_GATES:
            with self.subTest(gate=gate, state="missing"):
                manifest = valid_manifest()
                del manifest["gates"][gate]  # type: ignore[index]
                self.assert_rejected(manifest, "gates-incomplete")
            with self.subTest(gate=gate, state="failed"):
                manifest = valid_manifest()
                manifest["gates"][gate] = False  # type: ignore[index]
                self.assert_rejected(manifest, "gate-not-passed")

    def test_approval_is_only_mandatory_when_requested(self) -> None:
        manifest = valid_manifest(include_approval=False)
        rfc001a_manifest.validate_manifest(manifest)
        self.assert_rejected(
            manifest,
            "approval-required",
            require_approval=True,
        )

        refused = valid_manifest()
        refused["approval"]["approved"] = False  # type: ignore[index]
        rfc001a_manifest.validate_manifest(refused)
        self.assert_rejected(
            refused,
            "approval-required",
            require_approval=True,
        )

    def test_unknown_fields_fail_closed(self) -> None:
        manifest = valid_manifest()
        manifest["extra"] = "redacted"
        self.assert_rejected(manifest, "manifest-fields-invalid")

    def test_duplicate_json_keys_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(
                '{"schema_version":1,"schema_version":1}',
                encoding="utf-8",
            )
            with self.assertRaises(rfc001a_manifest.ManifestReadError) as raised:
                rfc001a_manifest.load_manifest(manifest_path)
        self.assertEqual(raised.exception.code, "manifest-duplicate-key")

    def test_manifest_size_is_bounded_to_one_mibibyte(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_bytes(b"x" * (rfc001a_manifest.MAX_MANIFEST_BYTES + 1))
            with self.assertRaises(rfc001a_manifest.ManifestReadError) as raised:
                rfc001a_manifest.load_manifest(manifest_path)
        self.assertEqual(raised.exception.code, "manifest-too-large")

    def test_path_and_json_depth_errors_are_redacted_read_failures(self) -> None:
        with self.assertRaises(rfc001a_manifest.ManifestReadError) as raised:
            rfc001a_manifest.load_manifest("invalid\0path")
        self.assertEqual(raised.exception.code, "manifest-unreadable")

        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text("[" * 2000 + "0" + "]" * 2000, encoding="utf-8")
            with self.assertRaises(rfc001a_manifest.ManifestReadError) as raised:
                rfc001a_manifest.load_manifest(manifest_path)
        self.assertEqual(raised.exception.code, "manifest-invalid-json")

    def test_json_depth_limit_is_explicit_and_parser_independent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(
                "[" * rfc001a_manifest.MAX_JSON_DEPTH + "0" + "]" * rfc001a_manifest.MAX_JSON_DEPTH,
                encoding="utf-8",
            )
            rfc001a_manifest.load_manifest(manifest_path)

            manifest_path.write_text(
                "[" * (rfc001a_manifest.MAX_JSON_DEPTH + 1)
                + "0"
                + "]" * (rfc001a_manifest.MAX_JSON_DEPTH + 1),
                encoding="utf-8",
            )
            with self.assertRaises(rfc001a_manifest.ManifestReadError) as raised:
                rfc001a_manifest.load_manifest(manifest_path)
        self.assertEqual(raised.exception.code, "manifest-invalid-json")


class ManifestCliTests(unittest.TestCase):
    def run_cli(
        self,
        manifest: object,
        *,
        require_approval: bool = False,
    ) -> tuple[int, str, str]:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            arguments = ["validate", "--manifest", str(manifest_path)]
            if require_approval:
                arguments.append("--require-approval")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                result = rfc001a_manifest.main(arguments)
            return result, stdout.getvalue(), stderr.getvalue()

    def test_validate_cli_passes_without_echoing_manifest(self) -> None:
        result, stdout, stderr = self.run_cli(
            valid_manifest(),
            require_approval=True,
        )
        self.assertEqual(result, 0)
        self.assertEqual(stdout, "PASS RFC001A_MANIFEST\n")
        self.assertEqual(stderr, "")
        self.assertNotIn("ganso_pgdata", stdout)
        self.assertNotIn(rfc001a_manifest.AUTHORIZED_UNLABELED_VOLUME, stdout)
        self.assertNotIn(rfc001a_manifest.AUTHORIZED_VOLUME_CONSUMER_ID, stdout)

    def test_validate_cli_never_prints_an_unknown_secret_value(self) -> None:
        sentinel = "do-not-print-this-secret-value"
        manifest = valid_manifest()
        manifest["yellowstone_token"] = sentinel

        result, stdout, stderr = self.run_cli(manifest)

        self.assertEqual(result, 1)
        self.assertIn("reason=manifest-fields-invalid", stderr)
        self.assertNotIn(sentinel, stdout + stderr)
        self.assertNotIn(json.dumps(manifest), stdout + stderr)

    def test_validate_cli_rejects_missing_required_approval(self) -> None:
        result, stdout, stderr = self.run_cli(
            valid_manifest(include_approval=False),
            require_approval=True,
        )
        self.assertEqual(result, 1)
        self.assertEqual(stdout, "")
        self.assertIn("reason=approval-required", stderr)


if __name__ == "__main__":
    unittest.main()
