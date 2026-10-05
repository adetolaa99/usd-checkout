// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IPyth } from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import { PythStructs } from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title UsdCheckout
/// @notice Merchants price invoices in US dollars; customers pay in HBAR. The HBAR amount is
///         derived at payment time from a Pyth price that the payer submits (and pays for) in the
///         same transaction, so the oracle is load-bearing: no fresh Pyth price, no payment.
/// @dev    Unit note: inside a Hedera smart contract `msg.value` and `address.balance` are in
///         tinybars (8 decimals), while JSON-RPC clients (wallets, viem, ethers) express value in
///         wei-style 18 decimals and the relay converts. The contract therefore keeps every amount
///         in "native units" and takes the number of native decimals as a constructor argument:
///         8 on Hedera, 18 on the local EVM test chain.
contract UsdCheckout is ReentrancyGuard {
    /// @notice Lifecycle of an invoice.
    enum Status {
        None,
        Open,
        Paid,
        Cancelled
    }

    /// @notice A dollar-denominated payment request.
    /// @param merchant Account that receives the HBAR.
    /// @param expiresAt Unix time after which the invoice can no longer be paid (0 = never).
    /// @param status Current lifecycle state.
    /// @param usdCents Amount due, in US cents.
    /// @param ref Free-form merchant reference (e.g. an order id), up to 32 bytes.
    struct Invoice {
        address merchant;
        uint64 expiresAt;
        Status status;
        uint128 usdCents;
        bytes32 ref;
    }

    /// @notice Settlement record written when an invoice is paid.
    /// @param payer Account that paid.
    /// @param paidAt Block timestamp of the payment.
    /// @param nativePaid Amount forwarded to the merchant, in native units.
    /// @param price Pyth HBAR/USD price used for the conversion.
    /// @param expo Exponent of `price` (price * 10^expo = USD per HBAR).
    struct Payment {
        address payer;
        uint64 paidAt;
        uint256 nativePaid;
        int64 price;
        int32 expo;
    }

    /// @dev Basis-point denominator for the confidence check.
    uint256 private constant BPS = 10_000;

    /// @notice Pyth contract this checkout reads and updates.
    IPyth public immutable PYTH;
    /// @notice Pyth price feed id used for HBAR/USD.
    bytes32 public immutable PRICE_ID;
    /// @notice Maximum age, in seconds, of a Pyth price accepted at payment time.
    uint256 public immutable MAX_PRICE_AGE;
    /// @notice Largest accepted price uncertainty (conf / price) in basis points.
    uint256 public immutable MAX_CONFIDENCE_BPS;
    /// @notice Decimals of the native unit seen by contracts (8 on Hedera, 18 on plain EVM chains).
    uint8 public immutable NATIVE_DECIMALS;

    /// @notice Number of invoices ever created; also the id of the newest invoice.
    uint256 public invoiceCount;

    /// @notice Invoice by id (ids start at 1).
    mapping(uint256 id => Invoice) public invoices;
    /// @notice Settlement record by invoice id.
    mapping(uint256 id => Payment) public payments;

    /// @notice Emitted when a merchant creates an invoice.
    event InvoiceCreated(uint256 indexed id, address indexed merchant, uint128 usdCents, uint64 expiresAt, bytes32 ref);
    /// @notice Emitted when an invoice is paid.
    event InvoicePaid(
        uint256 indexed id,
        address indexed payer,
        address indexed merchant,
        uint256 nativePaid,
        int64 price,
        int32 expo
    );
    /// @notice Emitted when a merchant cancels an open invoice.
    event InvoiceCancelled(uint256 indexed id);

    error InvalidConfig();
    error ZeroAmount();
    error ExpiryInPast(uint64 expiresAt);
    error NotMerchant(address caller, address merchant);
    error InvoiceNotOpen(uint256 id, Status status);
    error InvoiceExpired(uint256 id, uint64 expiresAt);
    error InsufficientPayment(uint256 required, uint256 provided);
    error PriceNotPositive(int64 price);
    error PriceTooUncertain(uint64 conf, int64 price);
    error UnsupportedExponent(int32 expo);
    error TransferFailed(address to, uint256 amount);

    /// @param pyth Pyth contract address on the target network.
    /// @param priceId Pyth price feed id for HBAR/USD.
    /// @param maxPriceAge Maximum accepted price age in seconds.
    /// @param maxConfidenceBps Maximum accepted conf/price ratio in basis points (e.g. 100 = 1%).
    /// @param nativeDecimals Decimals of the native unit seen by this contract (8 on Hedera).
    constructor(IPyth pyth, bytes32 priceId, uint256 maxPriceAge, uint256 maxConfidenceBps, uint8 nativeDecimals) {
        if (
            address(pyth) == address(0) ||
            priceId == bytes32(0) ||
            maxPriceAge == 0 ||
            maxConfidenceBps == 0 ||
            maxConfidenceBps > BPS ||
            nativeDecimals == 0 ||
            nativeDecimals > 18
        ) {
            revert InvalidConfig();
        }
        PYTH = pyth;
        PRICE_ID = priceId;
        MAX_PRICE_AGE = maxPriceAge;
        MAX_CONFIDENCE_BPS = maxConfidenceBps;
        NATIVE_DECIMALS = nativeDecimals;
    }

    /// @notice Creates an invoice payable to the caller.
    /// @param usdCents Amount due in US cents (1000 = $10.00).
    /// @param expiresAt Unix expiry time, or 0 for no expiry.
    /// @param ref Merchant reference (e.g. an order id).
    /// @return id The new invoice id.
    function createInvoice(uint128 usdCents, uint64 expiresAt, bytes32 ref) external returns (uint256 id) {
        if (usdCents == 0) revert ZeroAmount();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt);

        id = ++invoiceCount;
        invoices[id] = Invoice({
            merchant: msg.sender,
            expiresAt: expiresAt,
            status: Status.Open,
            usdCents: usdCents,
            ref: ref
        });
        emit InvoiceCreated(id, msg.sender, usdCents, expiresAt, ref);
    }

    /// @notice Cancels an unpaid invoice. Only the merchant can cancel.
    /// @param id Invoice id.
    function cancelInvoice(uint256 id) external {
        Invoice storage invoice = invoices[id];
        if (invoice.status != Status.Open) revert InvoiceNotOpen(id, invoice.status);
        if (invoice.merchant != msg.sender) revert NotMerchant(msg.sender, invoice.merchant);

        invoice.status = Status.Cancelled;
        emit InvoiceCancelled(id);
    }

    /// @notice Pays an invoice in HBAR using a fresh Pyth price.
    /// @dev `msg.value` must cover the Pyth update fee plus the converted invoice amount. Anything
    ///      above that is refunded to the caller in the same transaction, so callers can add a small
    ///      buffer against price movement between quote and execution.
    /// @param id Invoice id.
    /// @param priceUpdate Price update payload(s) fetched from Pyth Hermes. May be empty if the
    ///        on-chain Pyth price is already fresher than `MAX_PRICE_AGE`.
    function pay(uint256 id, bytes[] calldata priceUpdate) external payable nonReentrant {
        Invoice storage invoice = invoices[id];
        if (invoice.status != Status.Open) revert InvoiceNotOpen(id, invoice.status);
        if (invoice.expiresAt != 0 && block.timestamp > invoice.expiresAt) {
            revert InvoiceExpired(id, invoice.expiresAt);
        }

        uint256 fee = updateFee(priceUpdate);
        if (msg.value < fee) revert InsufficientPayment(fee, msg.value);
        if (fee > 0) PYTH.updatePriceFeeds{ value: fee }(priceUpdate);

        PythStructs.Price memory price = PYTH.getPriceNoOlderThan(PRICE_ID, MAX_PRICE_AGE);
        _checkPrice(price);

        uint256 available = msg.value - fee;
        uint256 required = usdToNative(invoice.usdCents, price.price, price.expo);
        if (available < required) revert InsufficientPayment(required, available);

        // Effects before interactions.
        invoice.status = Status.Paid;
        payments[id] = Payment({
            payer: msg.sender,
            paidAt: uint64(block.timestamp),
            nativePaid: required,
            price: price.price,
            expo: price.expo
        });
        emit InvoicePaid(id, msg.sender, invoice.merchant, required, price.price, price.expo);

        _send(invoice.merchant, required);
        uint256 refund = available - required;
        if (refund > 0) _send(msg.sender, refund);
    }

    /// @notice Pyth fee, in native units, for submitting `priceUpdate`.
    /// @param priceUpdate Price update payload(s) from Hermes.
    /// @return fee The fee to include in `msg.value` (0 for an empty payload).
    function updateFee(bytes[] calldata priceUpdate) public view returns (uint256 fee) {
        if (priceUpdate.length == 0) return 0;
        return PYTH.getUpdateFee(priceUpdate);
    }

    /// @notice Converts a US-cent amount to native units at a given Pyth price, rounding up so the
    ///         merchant is never underpaid by rounding.
    /// @param usdCents Amount in US cents.
    /// @param price Pyth price (USD per HBAR = price * 10^expo).
    /// @param expo Pyth price exponent, between -18 and 18.
    /// @return Amount in native units (tinybars on Hedera).
    function usdToNative(uint256 usdCents, int64 price, int32 expo) public view returns (uint256) {
        if (price <= 0) revert PriceNotPositive(price);
        if (expo < -18 || expo > 18) revert UnsupportedExponent(expo);

        // native = cents / 100 / (price * 10^expo) * 10^nativeDecimals
        uint256 denominator = 100 * uint256(uint64(price));
        if (expo < 0) {
            // casting is safe: expo is in [-18, -1] here
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 scale = 10 ** (uint256(NATIVE_DECIMALS) + uint256(uint32(-expo)));
            return Math.mulDiv(usdCents, scale, denominator, Math.Rounding.Ceil);
        }
        // casting is safe: expo is in [0, 18] here
        // forge-lint: disable-next-line(unsafe-typecast)
        denominator *= 10 ** uint256(uint32(expo));
        return Math.mulDiv(usdCents, 10 ** uint256(NATIVE_DECIMALS), denominator, Math.Rounding.Ceil);
    }

    /// @dev Rejects non-positive prices and prices whose confidence interval is too wide.
    function _checkPrice(PythStructs.Price memory price) private view {
        if (price.price <= 0) revert PriceNotPositive(price.price);
        if (uint256(price.conf) * BPS > uint256(uint64(price.price)) * MAX_CONFIDENCE_BPS) {
            revert PriceTooUncertain(price.conf, price.price);
        }
    }

    /// @dev Sends native units with `call`; reverts the whole payment on failure.
    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
