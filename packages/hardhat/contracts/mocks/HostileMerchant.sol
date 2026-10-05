// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { UsdCheckout } from "../UsdCheckout.sol";

/// @dev Test helper: a merchant contract that either rejects payments or tries to re-enter `pay`.
contract HostileMerchant {
    UsdCheckout private immutable CHECKOUT;
    bool private immutable REENTER;
    uint256 private invoiceId;

    constructor(UsdCheckout checkout, bool reenter) {
        CHECKOUT = checkout;
        REENTER = reenter;
    }

    function createInvoice(uint128 usdCents) external returns (uint256 id) {
        id = CHECKOUT.createInvoice(usdCents, 0, bytes32(0));
        invoiceId = id;
    }

    receive() external payable {
        if (REENTER) {
            bytes[] memory none = new bytes[](0);
            CHECKOUT.pay{ value: msg.value }(invoiceId, none);
        } else {
            revert("merchant rejects payment");
        }
    }
}
